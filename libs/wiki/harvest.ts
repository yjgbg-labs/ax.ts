import { readdir, mkdir, stat, appendFile } from "fs/promises";
import { resolve, basename } from "path";
import { homedir } from "os";
import { RAW_DIR } from "./page";

const IGNORE_FILE = resolve(RAW_DIR, "conversations", ".ignore");

async function loadIgnore(): Promise<Set<string>> {
  const set = new Set<string>();
  const f = Bun.file(IGNORE_FILE);
  if (!(await f.exists())) return set;
  for (const line of (await f.text()).split("\n")) {
    const s = line.replace(/#.*$/, "").trim();
    if (s) set.add(s);
  }
  return set;
}

export async function appendIgnore(sessionId: string, note?: string): Promise<void> {
  await mkdir(resolve(RAW_DIR, "conversations"), { recursive: true });
  const line = note ? `${sessionId}  # ${note}\n` : `${sessionId}\n`;
  await appendFile(IGNORE_FILE, line);
}

type Format = "claude" | "copilot";

interface Source {
  name: string;
  path: string;
  format: Format;
}

const SOURCES: Source[] = [
  { name: "ccc",     path: resolve(homedir(), ".ccc"),     format: "claude" },
  { name: "ccds",    path: resolve(homedir(), ".ccds"),    format: "claude" },
  { name: "mimo",    path: resolve(homedir(), ".mimo"),    format: "claude" },
  { name: "claude",  path: resolve(homedir(), ".claude"),  format: "claude" },
  { name: "copilot", path: resolve(homedir(), ".copilot"), format: "copilot" },
];

interface Turn {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

interface SessionSummary {
  source: string;
  sessionId: string;
  project: string;
  date: string;
  firstPrompt: string;
  userTurns: number;
  outFile: string;
  srcPath: string;
}

// ──────────────────────── Claude format ────────────────────────

interface ClaudeMsg {
  type: "user" | "assistant";
  timestamp: string;
  message: { role: string; content: string | unknown[] };
}

function extractUserText(content: string | unknown[]): string | null {
  if (typeof content === "string") return content.trim() || null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && b.text) parts.push(b.text);
    }
  }
  return parts.join("\n").trim() || null;
}

function extractAssistantText(content: string | unknown[]): string | null {
  if (typeof content === "string") return content.trim() || null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as { type?: string; text?: string; name?: string };
      if (b.type === "text" && b.text) parts.push(b.text);
      else if (b.type === "tool_use") parts.push(`<tool: ${b.name}>`);
    }
  }
  return parts.join("\n").trim() || null;
}

function isMetaMessage(t: string): boolean {
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-stdout>") ||
    t.startsWith("<local-command-caveat>") ||
    t.startsWith("[Request interrupted") ||
    t.startsWith("Caveat: The messages below")
  );
}

async function readClaudeSession(jsonlPath: string, sinceMs: number): Promise<{ turns: Turn[]; firstPrompt: string | null; firstTs: string | null }> {
  const text = await Bun.file(jsonlPath).text();
  const turns: Turn[] = [];
  let firstPrompt: string | null = null;
  let firstTs: string | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: ClaudeMsg;
    try { entry = JSON.parse(line) as ClaudeMsg; } catch { continue; }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.message?.content || !entry.timestamp) continue;

    const tsMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;

    if (entry.type === "user") {
      const t = extractUserText(entry.message.content);
      if (!t || isMetaMessage(t)) continue;
      if (!firstTs) { firstTs = entry.timestamp; firstPrompt = t; }
      turns.push({ role: "user", text: t, ts: entry.timestamp });
    } else {
      const t = extractAssistantText(entry.message.content);
      if (!t) continue;
      turns.push({ role: "assistant", text: t, ts: entry.timestamp });
    }
  }
  return { turns, firstPrompt, firstTs };
}

async function* iterClaudeSessions(rootPath: string): AsyncGenerator<{ jsonlPath: string; project: string }> {
  const projectsDir = resolve(rootPath, "projects");
  let entries;
  try { entries = await readdir(projectsDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projDir = resolve(projectsDir, e.name);
    let files;
    try { files = await readdir(projDir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith(".jsonl")) yield { jsonlPath: resolve(projDir, f), project: e.name };
    }
  }
}

// ──────────────────────── Copilot format ────────────────────────

interface CopilotEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

async function readCopilotSession(eventsPath: string, sinceMs: number): Promise<{ turns: Turn[]; firstPrompt: string | null; firstTs: string | null; project: string }> {
  const text = await Bun.file(eventsPath).text();
  const turns: Turn[] = [];
  let firstPrompt: string | null = null;
  let firstTs: string | null = null;
  let project = "unknown";

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: CopilotEvent;
    try { ev = JSON.parse(line) as CopilotEvent; } catch { continue; }

    if (ev.type === "session.start") {
      const ctx = (ev.data?.context as { cwd?: string } | undefined);
      if (ctx?.cwd) project = ctx.cwd;
      continue;
    }

    if (ev.type !== "user.message" && ev.type !== "assistant.message") continue;
    if (!ev.timestamp) continue;
    const tsMs = Date.parse(ev.timestamp);
    if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;

    const content = (ev.data?.content as string | undefined)?.trim();

    if (ev.type === "user.message") {
      if (!content || isMetaMessage(content)) continue;
      if (!firstTs) { firstTs = ev.timestamp; firstPrompt = content; }
      turns.push({ role: "user", text: content, ts: ev.timestamp });
    } else {
      const tools = ev.data?.toolRequests as Array<{ name?: string }> | undefined;
      const parts: string[] = [];
      if (content) parts.push(content);
      if (tools) for (const t of tools) if (t.name) parts.push(`<tool: ${t.name}>`);
      const t = parts.join("\n").trim();
      if (!t) continue;
      turns.push({ role: "assistant", text: t, ts: ev.timestamp });
    }
  }
  return { turns, firstPrompt, firstTs, project };
}

async function* iterCopilotSessions(rootPath: string): AsyncGenerator<{ eventsPath: string; sessionId: string }> {
  const stateDir = resolve(rootPath, "session-state");
  let entries;
  try { entries = await readdir(stateDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const eventsPath = resolve(stateDir, e.name, "events.jsonl");
    try { await stat(eventsPath); } catch { continue; }
    yield { eventsPath, sessionId: e.name };
  }
}

// ──────────────────────── Common ────────────────────────

function slugify(s: string): string {
  return s
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}\-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
    .toLowerCase();
}

async function writeSession(
  source: string,
  sessionId: string,
  project: string,
  firstPrompt: string,
  firstTs: string,
  turns: Turn[],
  srcPath: string,
  dryRun: boolean,
): Promise<SessionSummary> {
  const date = firstTs.slice(0, 10);
  const topicSlug = slugify(firstPrompt.split("\n")[0]) || "untitled";
  const outName = `${date}-${topicSlug}-${sessionId.slice(0, 8)}.md`;
  const outDir = resolve(RAW_DIR, "conversations", source);
  const outFile = resolve(outDir, outName);

  if (!dryRun) {
    await mkdir(outDir, { recursive: true });
    const fm = [
      "---",
      `source_kind: conversation`,
      `source_backend: ${source}`,
      `session_id: ${sessionId}`,
      `project: ${project}`,
      `source_date: ${date}`,
      `turns: ${turns.length}`,
      `first_prompt: ${JSON.stringify(firstPrompt.split("\n")[0].slice(0, 200))}`,
      "---",
      "",
    ].join("\n");
    const body = turns.map((t) => `## ${t.role} · ${t.ts}\n\n${t.text}\n`).join("\n");
    await Bun.write(outFile, fm + body);
  }

  return {
    source,
    sessionId,
    project,
    date,
    firstPrompt: firstPrompt.split("\n")[0].slice(0, 80),
    userTurns: turns.filter((t) => t.role === "user").length,
    outFile,
    srcPath,
  };
}

export async function harvest(opts: { source?: string; project?: string; since?: string; minTurns?: number; dryRun?: boolean }): Promise<SessionSummary[]> {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const minTurns = opts.minTurns ?? 1;
  const dryRun = opts.dryRun ?? false;
  const sources = opts.source ? SOURCES.filter((s) => s.name === opts.source) : SOURCES;
  const ignore = await loadIgnore();

  const results: SessionSummary[] = [];

  for (const src of sources) {
    try { await stat(src.path); } catch { continue; }

    if (src.format === "claude") {
      for await (const { jsonlPath, project } of iterClaudeSessions(src.path)) {
        if (opts.project && project !== opts.project) continue;
        const sessionId = basename(jsonlPath, ".jsonl");
        if (ignore.has(sessionId)) continue;
        const { turns, firstPrompt, firstTs } = await readClaudeSession(jsonlPath, sinceMs);
        if (!firstTs || !firstPrompt || turns.length === 0) continue;
        const userCount = turns.filter((t) => t.role === "user").length;
        if (userCount < minTurns) continue;
        results.push(await writeSession(src.name, sessionId, project, firstPrompt, firstTs, turns, jsonlPath, dryRun));
      }
    } else if (src.format === "copilot") {
      for await (const { eventsPath, sessionId } of iterCopilotSessions(src.path)) {
        if (ignore.has(sessionId)) continue;
        const { turns, firstPrompt, firstTs, project } = await readCopilotSession(eventsPath, sinceMs);
        if (opts.project && project !== opts.project) continue;
        if (!firstTs || !firstPrompt || turns.length === 0) continue;
        const userCount = turns.filter((t) => t.role === "user").length;
        if (userCount < minTurns) continue;
        results.push(await writeSession(src.name, sessionId, project, firstPrompt, firstTs, turns, eventsPath, dryRun));
      }
    }
  }
  return results;
}

export { SOURCES };
