#!/usr/bin/env bun
const BASE = "http://vm.yjgbg.lab";

async function apiFetch(path: string) {
  const resp = await fetch(`${BASE}${path}`);
  const json = await resp.json() as { status: string; data: unknown; error?: string };
  if (json.status !== "success") throw new Error(json.error ?? "API error");
  return json.data;
}

async function query(promql: string) {
  const data = await apiFetch(`/api/v1/query?query=${encodeURIComponent(promql)}`) as {
    resultType: string;
    result: { metric: Record<string, string>; value: [number, string] }[];
  };

  if (!data.result.length) { console.log("(no results)"); return; }

  for (const { metric, value } of data.result) {
    const labels = Object.entries(metric)
      .filter(([k]) => k !== "__name__")
      .map(([k, v]) => `${k}="${v}"`)
      .join(", ");
    const name = metric.__name__ ?? promql;
    console.log(`${name}{${labels}} = ${value[1]}`);
  }
}

async function metrics(filter?: string) {
  const names = await apiFetch("/api/v1/label/__name__/values") as string[];
  const filtered = filter ? names.filter(n => n.includes(filter)) : names;
  filtered.forEach(n => console.log(n));
}

function usage() {
  console.log(`Usage: ax.ts prometheus <command>

Commands:
  query <promql>      即时查询 PromQL 表达式
  metrics [filter]    列出所有 metric 名（可按关键字过滤）`);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "query":
    if (!args[0]) { console.error("Usage: prometheus query <promql>"); process.exit(1); }
    await query(args.join(" "));
    break;
  case "metrics":
    await metrics(args[0]);
    break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
