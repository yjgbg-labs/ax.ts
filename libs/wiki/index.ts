#!/usr/bin/env bun
import { resolve, basename, relative } from "path";
import { mkdir, appendFile } from "fs/promises";
import {
  WIKI_DIR, WIKI_PAGES_DIR, RAW_DIR, INDEX_FILE, LOG_FILE, SCHEMA_FILE,
  loadAllPages, loadPage, findBySlug, walkMarkdown,
  parseFrontmatter, stringifyFrontmatter,
  today, nowStamp,
  type PageType, type Frontmatter, type Page,
} from "./page";
import { buildGraph, backlinksOf, exportGraph, graphToDot, extractLinks } from "./links";
import { lint, formatReport } from "./lint";
import { harvest, appendIgnore } from "./harvest";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(args: string[]) {
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { opts[key] = next; i++; }
      else flags.add(key);
    } else pos.push(a);
  }
  return { opts, flags, pos };
}

function err(msg: string): never {
  console.error(`\x1b[31m${msg}\x1b[0m`);
  process.exit(1);
}

async function resolvePage(slug: string): Promise<Page> {
  const matches = await findBySlug(slug);
  if (matches.length === 0) err(`No page found for slug: ${slug}`);
  if (matches.length > 1) {
    console.error(`Ambiguous slug "${slug}", candidates:`);
    for (const m of matches) console.error(`  ${m.rel}`);
    process.exit(1);
  }
  return matches[0];
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(args: string[]) {
  const { opts } = parseArgs(args);
  const pages = await loadAllPages();
  const type = opts.type;
  const tag = opts.tag;
  const limit = opts.limit ? parseInt(opts.limit) : Infinity;

  // If no filter, prefer cat'ing index.md when it exists
  if (!type && !tag) {
    const indexFile = Bun.file(INDEX_FILE);
    if (await indexFile.exists()) {
      process.stdout.write(await indexFile.text());
      return;
    }
  }

  let filtered = pages;
  if (type) filtered = filtered.filter((p) => p.frontmatter.type === type);
  if (tag) filtered = filtered.filter((p) => (p.frontmatter.tags ?? []).includes(tag));
  filtered = filtered.slice(0, limit);

  const slugW = Math.max(4, ...filtered.map((p) => p.frontmatter.slug.length));
  for (const p of filtered) {
    const fm = p.frontmatter;
    const tags = (fm.tags ?? []).join(",");
    console.log(`${fm.slug.padEnd(slugW)}  ${fm.type.padEnd(8)}  ${fm.title}  ${tags ? `[${tags}]` : ""}`);
  }
  console.error(`(${filtered.length}/${pages.length} pages)`);
}

async function cmdShow(args: string[]) {
  const { pos } = parseArgs(args);
  if (!pos[0]) err("Usage: wiki show <slug>");
  const page = await resolvePage(pos[0]);
  process.stdout.write(await Bun.file(page.path).text());
}

async function cmdSearch(args: string[]) {
  const { opts, pos } = parseArgs(args);
  if (!pos.length) err("Usage: wiki search <query> [--type T] [--limit N]");
  const query = pos.join(" ");
  const limit = opts.limit ?? "50";

  const searchPaths: string[] = [];
  if (opts.type) {
    // Limit to subdir for type filter
    searchPaths.push(resolve(WIKI_PAGES_DIR, opts.type));
  } else {
    searchPaths.push(WIKI_PAGES_DIR);
  }

  const grepArgs = ["-rn", "--include=*.md", "--color=never", "-m", limit, "-e", query, ...searchPaths];
  const proc = Bun.spawn(["grep", ...grepArgs], { stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
}

async function cmdLog(args: string[]) {
  const n = parseInt(args[0] ?? "10");
  const file = Bun.file(LOG_FILE);
  if (!await file.exists()) { console.error("No log.md yet."); return; }
  const text = await file.text();
  const entries = text.split(/(?=^## \[)/m).filter((s) => s.trim());
  for (const e of entries.slice(-n)) process.stdout.write(e);
}

async function cmdBacklinks(args: string[]) {
  const { pos } = parseArgs(args);
  if (!pos[0]) err("Usage: wiki backlinks <slug>");
  const pages = await loadAllPages();
  const graph = buildGraph(pages);
  const refs = backlinksOf(graph, pos[0]);
  for (const r of refs) console.log(r);
  console.error(`(${refs.length} backlinks)`);
}

async function cmdGraph(args: string[]) {
  const { opts } = parseArgs(args);
  const pages = await loadAllPages();
  const graph = buildGraph(pages);
  const exp = exportGraph(pages, graph, {
    from: opts.from,
    depth: opts.depth ? parseInt(opts.depth) : undefined,
  });
  if (opts.format === "dot") console.log(graphToDot(exp));
  else console.log(JSON.stringify(exp, null, 2));
}

async function cmdLint() {
  const pageFiles = await walkMarkdown(WIKI_PAGES_DIR);
  const pages: Page[] = [];
  const validPaths = new Set<string>();
  for (const f of pageFiles) {
    const p = await loadPage(f);
    if (p) { pages.push(p); validPaths.add(f); }
  }
  const graph = buildGraph(pages);
  const report = lint(pages, graph, pageFiles, validPaths);
  console.log(formatReport(report));
}

const VALID_TYPES: PageType[] = ["entity", "concept", "source", "overview"];

async function cmdNew(args: string[]) {
  const { opts, pos } = parseArgs(args);
  const [type, slug] = pos;
  if (!type || !slug) err("Usage: wiki new <type> <slug> [--title T] [--tags t1,t2]");
  if (!VALID_TYPES.includes(type as PageType)) err(`Invalid type: ${type}. Must be one of ${VALID_TYPES.join("|")}`);

  const existing = await findBySlug(slug);
  if (existing.length) err(`Page with slug "${slug}" already exists: ${existing[0].rel}`);

  const title = opts.title ?? slug;
  const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()) : undefined;
  const fm: Frontmatter = {
    slug,
    title,
    type: type as PageType,
    ...(tags ? { tags } : {}),
    created: today(),
    updated: today(),
  };
  const body = `\n# ${title}\n\n`;
  const dir = resolve(WIKI_PAGES_DIR, type);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${slug}.md`);
  await Bun.write(path, stringifyFrontmatter(fm, body));
  console.log(relative(WIKI_DIR, path));
}

async function cmdTouch(args: string[]) {
  const { opts, pos } = parseArgs(args);
  if (!pos[0]) err("Usage: wiki touch <slug> [--add-source S] [--add-tag T]");
  const page = await resolvePage(pos[0]);
  const fm = page.frontmatter;
  fm.updated = today();
  if (opts["add-source"]) {
    fm.sources = [...(fm.sources ?? [])];
    if (!fm.sources.includes(opts["add-source"])) fm.sources.push(opts["add-source"]);
  }
  if (opts["add-tag"]) {
    fm.tags = [...(fm.tags ?? [])];
    if (!fm.tags.includes(opts["add-tag"])) fm.tags.push(opts["add-tag"]);
  }
  await Bun.write(page.path, stringifyFrontmatter(fm, page.body));
  console.log(`updated ${page.rel}`);
}

async function cmdLogAppend(args: string[]) {
  const [op, ...msgParts] = args;
  if (!op) err("Usage: wiki log-append <op> <message>");
  const message = msgParts.join(" ");
  const line = `\n## [${nowStamp()}] ${op}${message ? ` | ${message}` : ""}\n`;
  await appendFile(LOG_FILE, line);
  console.error(`appended to ${relative(WIKI_DIR, LOG_FILE)}`);
}

async function cmdHarvest(args: string[]) {
  const { opts, flags } = parseArgs(args);
  const results = await harvest({
    source: opts.source,
    project: opts.project,
    since: opts.since,
    minTurns: opts["min-turns"] ? parseInt(opts["min-turns"]) : undefined,
    dryRun: flags.has("dry-run"),
  });
  for (const r of results) {
    const out = flags.has("dry-run") ? "[dry]" : "→";
    console.log(`${out} ${r.date}  [${r.source}] ${r.userTurns}t  ${basename(r.outFile)}  ${r.firstPrompt}`);
  }
  console.error(`(${results.length} sessions${flags.has("dry-run") ? ", dry-run" : ""})`);
}

async function cmdIgnore(args: string[]) {
  if (args.length === 0) err("Usage: wiki ignore <path>...");
  const { unlink } = await import("fs/promises");
  for (const arg of args) {
    const p = resolve(arg);
    const page = await loadPage(p);
    const sessionId = page?.frontmatter.session_id as string | undefined;
    if (!sessionId) {
      console.error(`skip ${arg}: no session_id in frontmatter`);
      continue;
    }
    const note = (page?.frontmatter.first_prompt as string | undefined)?.slice(0, 60);
    await appendIgnore(sessionId, note);
    await unlink(p);
    console.log(`ignored ${sessionId}  (removed ${basename(p)})`);
  }
}

async function cmdSchema() {
  const file = Bun.file(SCHEMA_FILE);
  if (!await file.exists()) {
    console.error(`No schema file at ${SCHEMA_FILE}. Run 'wiki init' first.`);
    process.exit(1);
  }
  process.stdout.write(await file.text());
}

async function cmdInit() {
  await mkdir(WIKI_DIR, { recursive: true });
  await mkdir(WIKI_PAGES_DIR, { recursive: true });
  await mkdir(resolve(WIKI_PAGES_DIR, "entity"), { recursive: true });
  await mkdir(resolve(WIKI_PAGES_DIR, "concept"), { recursive: true });
  await mkdir(resolve(WIKI_PAGES_DIR, "source"), { recursive: true });
  await mkdir(resolve(WIKI_PAGES_DIR, "overview"), { recursive: true });
  await mkdir(resolve(RAW_DIR, "conversations"), { recursive: true });
  await mkdir(resolve(RAW_DIR, "articles"), { recursive: true });
  await mkdir(resolve(RAW_DIR, "papers"), { recursive: true });
  await mkdir(resolve(RAW_DIR, "assets"), { recursive: true });

  if (!await Bun.file(INDEX_FILE).exists()) {
    await Bun.write(INDEX_FILE, "# Wiki Index\n\n## Entities\n\n## Concepts\n\n## Sources\n\n## Overview\n");
  }
  if (!await Bun.file(LOG_FILE).exists()) {
    await Bun.write(LOG_FILE, `# Wiki Log\n\n## [${nowStamp()}] init | wiki initialized\n`);
  }
  console.log(`Initialized wiki at ${WIKI_DIR}`);
  console.log(`Next: write ${SCHEMA_FILE} (see 'ax.ts wiki schema' once it exists)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage: ax.ts wiki <command> [args...]   (WIKI_DIR=${WIKI_DIR})

Read:
  list [--type T] [--tag T] [--limit N]   列出页面（默认 cat index.md）
  show <slug>                              输出页面全文
  search <query> [--type T] [--limit N]    ripgrep 全文搜索
  log [N]                                  最近 N 条 log（默认 10）
  backlinks <slug>                         反向链接
  graph [--from slug --depth N] [--format json|dot]

Write:
  new <type> <slug> [--title T] [--tags t1,t2]
  touch <slug> [--add-source S] [--add-tag T]
  log-append <op> <message>

Harvest:
  harvest [--source NAME] [--project P] [--since YYYY-MM-DD] [--min-turns N] [--dry-run]
  ignore <path>...                         读 frontmatter session_id 加入 .ignore 并删除文件

Maintenance:
  lint                                     健康检查
  schema                                   输出 CLAUDE.md
  init                                     初始化目录结构`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "list":       await cmdList(rest); break;
  case "show":       await cmdShow(rest); break;
  case "search":     await cmdSearch(rest); break;
  case "log":        await cmdLog(rest); break;
  case "backlinks":  await cmdBacklinks(rest); break;
  case "graph":      await cmdGraph(rest); break;
  case "lint":       await cmdLint(); break;
  case "new":        await cmdNew(rest); break;
  case "touch":      await cmdTouch(rest); break;
  case "log-append": await cmdLogAppend(rest); break;
  case "harvest":    await cmdHarvest(rest); break;
  case "ignore":     await cmdIgnore(rest); break;
  case "schema":     await cmdSchema(); break;
  case "init":       await cmdInit(); break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
