#!/usr/bin/env bun

const DISALLOWED_TOOLS =
  "WebFetch WebSearch TaskOutput Agent(claude-code-guide) RemoteTrigger PushNotification NotebookEdit ScheduleWakeup";

// 走 libs/mcp-proxy（监听 :4142），上游失败时无限指数退避重试，绕过 CC
// HTTP MCP 客户端 5 次重连上限。API key 在代理里。
const TAVILY_MCP = {
  "tavily-remote-mcp": {
    type: "http",
    url: "http://127.0.0.1:4142/tavily",
  }
};

function vaultGet(key: string): string {
  const r = Bun.spawnSync(["ax.ts", "vault", "get", key], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`vault get ${key}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

const HOME = process.env.HOME!;

const COMMON_ENV = {
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
  CLAUDE_CODE_NO_FLICKER: "1",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  CLAUDE_CONFIG_DIR: `${HOME}/.cc`,
};

// ── Backends ──────────────────────────────────────────────────────────────────

type Backend = {
  baseUrl: string;
  authToken: string | { vault: string };
  sonnet: string;
  opus: string;
  haiku: string;
};

const BACKENDS: Record<string, Backend> = {
  copilot: {
    baseUrl: "http://10.0.0.130:4141",
    authToken: "dummy",
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-7",
    haiku: "claude-haiku-4-5",
  },
  "copilot-local": {
    baseUrl: "http://localhost:4141",
    authToken: "dummy",
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-8",
    haiku: "claude-haiku-4-5",
  },
  ds: {
    baseUrl: "https://api.deepseek.com/anthropic",
    authToken: { vault: "deepseek_key" },
    sonnet: "deepseek-v4-pro[1m]",
    opus: "deepseek-v4-pro[1m]",
    haiku: "deepseek-v4-flash",
  },
  mimo: {
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    authToken: { vault: "mimo_token_plan_token" },
    sonnet: "mimo-v2.5-pro[1m]",
    opus: "mimo-v2.5-pro[1m]",
    haiku: "mimo-v2.5",
  },
};

// ── Main ──────────────────────────────────────────────────────────────────────

const [name, ...rest] = process.argv.slice(2);
const backend = name ? BACKENDS[name] : undefined;

if (!backend) {
  console.error(`Usage: ax.ts cc <${Object.keys(BACKENDS).join("|")}> [claude args...]`);
  process.exit(1);
}

const token = typeof backend.authToken === "string" ? backend.authToken : vaultGet(backend.authToken.vault);

const env = {
  ...COMMON_ENV,
  ANTHROPIC_BASE_URL: backend.baseUrl,
  ANTHROPIC_AUTH_TOKEN: token,
  ANTHROPIC_DEFAULT_SONNET_MODEL: backend.sonnet,
  ANTHROPIC_DEFAULT_OPUS_MODEL: backend.opus,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: backend.haiku,
};

const mcpServers = { ...TAVILY_MCP };

const proc = Bun.spawn(
  ["claude", "--disallowed-tools", DISALLOWED_TOOLS, "--dangerously-skip-permissions",
    "--mcp-config", JSON.stringify({ mcpServers }), ...rest],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } },
);
process.exit(await proc.exited);
