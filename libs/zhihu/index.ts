#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 19222;
const AGENT_BROWSER = resolve(__dirname, "../agent-browser/node_modules/.bin/agent-browser");
const PROXY = process.env.ZHIHU_PROXY || "http://10.0.0.1:7890";

// ── agent-browser helpers ─────────────────────────────────────────────────────

async function runAgent(args: string[], opts?: { timeout?: number }): Promise<string> {
  const proc = Bun.spawn([AGENT_BROWSER, "--cdp", String(CDP_PORT), ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const timer = opts?.timeout ? setTimeout(() => { proc.kill(); }, opts.timeout) : undefined;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if (timer) clearTimeout(timer);
  const code = await proc.exited;
  if (code !== 0 && err.trim()) throw new Error(err.trim());
  return out.trim();
}

async function cdpAlive(): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch { return false; }
}

async function ensureBrowser() {
  if (await cdpAlive()) return;
  const args = ["--cdp", String(CDP_PORT), "navigate", "about:blank"];
  if (PROXY) args.push("--proxy", PROXY);
  const proc = Bun.spawn([AGENT_BROWSER, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  await proc.exited;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await cdpAlive()) return;
    await Bun.sleep(500);
  }
  throw new Error("Chrome CDP not ready after 30s");
}

// ── Script loading ────────────────────────────────────────────────────────────

async function loadScript(name: string): Promise<string> {
  return await Bun.file(resolve(__dirname, name)).text();
}

// ── URL parsing ──────────────────────────────────────────────────────────────

function parseUrl(url: string) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/question\/(\d+)(?:\/answer\/(\d+))?/);
  if (!m) throw new Error(`Not a valid Zhihu URL: ${url}`);
  return { type: (m[2] ? "answer" : "question") as "question" | "answer", questionId: m[1], answerId: m[2] };
}

// ── Question / Answer view ───────────────────────────────────────────────────

async function view(url: string, opts: { comments: boolean; json: boolean }) {
  const parsed = parseUrl(url);
  const pageUrl = `https://www.zhihu.com/question/${parsed.questionId}`;

  await ensureBrowser();
  await runAgent(["navigate", pageUrl], { timeout: 30_000 });
  await Bun.sleep(1500);

  const extractScript = await loadScript("extract.js");
  const result = await runAgent(["eval", extractScript], { timeout: 15_000 });
  if (!result || result.startsWith('"error"'))
    throw new Error("Zhihu blocked the request (403). Try a different proxy or network.");
  const data = JSON.parse(result);

  if (opts.json) {
    if (opts.comments) {
      await expandComments();
      await Bun.sleep(1500);
      try {
        const cs = await loadScript("comments.js");
        data.commentSections = JSON.parse(await runAgent(["eval", cs], { timeout: 10_000 }));
      } catch {}
    }
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Title: ${data.title || "(unknown)"}`);
  if (data.topics?.length) console.log(`Topics: ${data.topics.join(", ")}`);
  console.log(`Followers: ${(data.followers || 0).toLocaleString()}  Views: ${(data.views || 0).toLocaleString()}`);
  if (data.questionDetail) {
    const qd = data.questionDetail.length > 500 ? data.questionDetail.slice(0, 500) + "..." : data.questionDetail;
    console.log(`\nQuestion: ${qd}`);
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`Answers (${data.answers?.length || 0} shown):`);
  for (let i = 0; i < (data.answers || []).length; i++) {
    const a = data.answers[i];
    console.log(`\n  [${i + 1}] ${a.author}${a.bio ? " · " + a.bio : ""}`);
    console.log(`      ${a.votes} upvotes  ${a.commentCount} comments  ${a.date}${a.location ? " · " + a.location : ""}`);
    const content = (a.content || "").length > 2000 ? a.content.slice(0, 2000) + "\n... (truncated)" : a.content;
    console.log(content.replace(/^/gm, "      "));
  }

  if (opts.comments) {
    console.log(`\n${"-".repeat(60)}`);
    console.log("Loading comments...");
    await expandComments();
    await Bun.sleep(1500);
    try {
      const cs = await loadScript("comments.js");
      const sections = JSON.parse(await runAgent(["eval", cs], { timeout: 10_000 }));
      if (!sections.length) {
        console.log("No comments found (may require login).");
      } else {
        for (const sec of sections) {
          console.log(`\n  [${sec.answerId} — ${sec.comments.length} comments]`);
          for (const c of sec.comments.slice(0, 30)) {
            console.log(`    ${c.author}${c.isAuthor ? " (作者)" : ""}: ${(c.content || "").slice(0, 120)}`);
            console.log(`      ${c.date} | ${c.votes}赞`);
          }
          if (sec.comments.length > 30) console.log(`    ... and ${sec.comments.length - 30} more`);
        }
      }
    } catch { console.log("Failed to parse comments."); }
  }
}

async function expandComments() {
  try {
    const script = await loadScript("expand_comments.js");
    await runAgent(["eval", script], { timeout: 10_000 });
  } catch { /* ignore */ }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function search(query: string, opts: { json: boolean }) {
  // Zhihu's internal search API needs anti-bot signature.
  // Use DuckDuckGo's site: search as a reliable workaround.
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent("site:zhihu.com " + query)}`;

  await ensureBrowser();
  await runAgent(["navigate", ddgUrl], { timeout: 30_000 });
  await Bun.sleep(1500);

  const result = await runAgent(["eval", `(() => {
    var results = [];
    document.querySelectorAll('.web-result').forEach(function(item) {
      var link = item.querySelector('.result__a');
      if (!link) return;
      var title = link.textContent.trim();
      var url = link.href;
      var m = url.match(/uddg=([^&]+)/);
      if (m) url = decodeURIComponent(m[1]);
      var urlEl = item.querySelector('.result__url');
      if (urlEl && url.indexOf('zhihu.com') === -1) url = urlEl.textContent.trim();
      var snippet = item.querySelector('.result__snippet');
      var desc = snippet ? snippet.textContent.trim() : '';
      if (title && url && url.indexOf('zhihu.com') !== -1) {
        results.push({ title: title, url: url, snippet: desc });
      }
    });
    return results.slice(0, 20);
  })()`], { timeout: 15_000 });

  let results: any[] = [];
  try { results = JSON.parse(result); } catch {}

  if (opts.json) {
    console.log(JSON.stringify({ query, results }, null, 2));
    return;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Zhihu Search: ${query}`);
  console.log(`Results: ${results.length}\n`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`  [${i + 1}] ${r.title}`);
    console.log(`      ${r.url}`);
    if (r.snippet) console.log(`      ${r.snippet.slice(0, 200)}`);
    console.log();
  }
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage: zhihu <url> [--comments] [--json]
  zhihu search <query> [--json]

  ax.ts zhihu https://www.zhihu.com/question/22796619
  ax.ts zhihu https://www.zhihu.com/question/22796619/answer/2042624060656505856 --comments
  ax.ts zhihu search 以太坊
  ax.ts zhihu search "产后 夫妻关系" --json

Options:
  --comments   Expand and show comments (requires JS execution)
  --json       Output structured JSON instead of text`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  // "search" subcommand
  if (args[0] === "search") {
    const query = args.slice(1).filter(a => !a.startsWith("--")).join(" ");
    if (!query || args.includes("--help") || args.includes("-h")) { usage(); process.exit(query ? 0 : 1); }
    try {
      await search(query, { json: args.includes("--json") });
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const url = args.find(a => a.startsWith("http"));
  const showComments = args.includes("--comments");
  const json = args.includes("--json");

  if (!url || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(url ? 0 : 1);
  }

  try {
    await view(url, { comments: showComments, json });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
