#!/usr/bin/env bun
const BASE = "http://quickwit.yjgbg.lab/api/v1";

async function search(index: string, query: string, limit: number) {
  const resp = await fetch(`${BASE}/${index}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_hits: limit }),
  });
  const json = await resp.json() as any;
  if (json.message) throw new Error(json.message);
  if (json.errors?.length) throw new Error(json.errors.join(", "));
  return json as { hits: unknown[]; num_hits: number };
}

function parseArgs(args: string[]) {
  const opts: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2)] = args[++i];
    } else {
      pos.push(args[i]);
    }
  }
  return { opts, pos };
}

function fmtTime(nanos: number) {
  return new Date(nanos / 1e6).toISOString().replace("T", " ").slice(0, 19);
}

// ── logs ──────────────────────────────────────────────────────────────────────

async function logs(args: string[]) {
  const { opts, pos } = parseArgs(args);
  const limit = parseInt(opts.limit ?? opts.n ?? "50");
  const parts: string[] = [];

  if (pos.length) parts.push(pos.join(" "));
  if (opts.namespace) parts.push(`resource_attributes.k8s.namespace.name:${opts.namespace}`);
  if (opts.pod) parts.push(`resource_attributes.k8s.pod.name:${opts.pod}`);
  if (opts.container) parts.push(`resource_attributes.k8s.container.name:${opts.container}`);

  const query = parts.join(" AND ") || "*";
  const result = await search("otel-logs-v0_7", query, limit);

  for (const hit of result.hits as any[]) {
    const ts = fmtTime(hit.timestamp_nanos);
    const ns = hit.resource_attributes?.["k8s.namespace.name"] ?? "-";
    const pod = hit.resource_attributes?.["k8s.pod.name"] ?? hit.service_name ?? "-";
    const msg = hit.body?.message ?? "";
    console.log(`${ts}  [${ns}/${pod}]  ${msg}`);
  }
  console.error(`(${result.num_hits} total hits, showing ${result.hits.length})`);
}

// ── events ────────────────────────────────────────────────────────────────────

async function events(args: string[]) {
  const { opts, pos } = parseArgs(args);
  const limit = parseInt(opts.limit ?? opts.n ?? "20");
  const parts: string[] = [];

  if (pos.length) parts.push(pos.join(" "));
  if (opts.agent) parts.push(`agent:"${opts.agent}"`);
  if (opts.type) parts.push(`event_type:"${opts.type}"`);
  if (opts.session) parts.push(`session_id:"${opts.session}"`);

  const query = parts.join(" AND ") || "*";
  const result = await search("agent-events", query, limit);

  for (const hit of result.hits as any[]) {
    const ts = fmtTime(hit.timestamp_nanos);
    const agent = hit.agent ?? "-";
    const type = hit.event_type ?? "-";
    const content = hit.content ? `  ${hit.content.slice(0, 120)}` : "";
    console.log(`${ts}  [${agent}] ${type}${content}`);
  }
  console.error(`(${result.num_hits} total hits, showing ${result.hits.length})`);
}

// ── raw search ────────────────────────────────────────────────────────────────

async function rawSearch(args: string[]) {
  const { opts, pos } = parseArgs(args);
  if (!pos[0]) { console.error("Usage: quickwit search <index> [query]"); process.exit(1); }
  const index = pos[0];
  const query = pos.slice(1).join(" ") || "*";
  const limit = parseInt(opts.limit ?? opts.n ?? "10");
  const result = await search(index, query, limit);
  console.log(JSON.stringify(result.hits, null, 2));
  console.error(`(${result.num_hits} total hits, showing ${result.hits.length})`);
}

// ── indexes ───────────────────────────────────────────────────────────────────

async function indexes() {
  const resp = await fetch(`${BASE}/indexes`);
  const data = await resp.json() as any[];
  for (const idx of data) console.log(idx.index_config.index_id);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage: ax.ts quickwit <command> [options]

Commands:
  logs [query] [--namespace NS] [--pod POD] [--container C] [--limit N]
               搜索 Kubernetes 容器日志
  events [query] [--agent AGENT] [--type TYPE] [--session ID] [--limit N]
               搜索 agent-events 事件日志
  search <index> [query] [--limit N]
               原始搜索任意索引，输出 JSON
  indexes      列出所有索引`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "logs":    await logs(rest); break;
  case "events":  await events(rest); break;
  case "search":  await rawSearch(rest); break;
  case "indexes": await indexes(); break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
