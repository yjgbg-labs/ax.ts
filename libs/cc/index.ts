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

async function launch(
  env: Record<string, string>,
  mcpServers: Record<string, unknown>,
  args: string[],
): Promise<void> {
  const proc = Bun.spawn(
    ["claude", "--disallowed-tools", DISALLOWED_TOOLS, "--dangerously-skip-permissions",
      "--mcp-config", JSON.stringify({ mcpServers }), ...args],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } },
  );
  process.exit(await proc.exited);
}

const HOME = process.env.HOME!;

const COMMON_ENV = {
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
  CLAUDE_CODE_NO_FLICKER: "1",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
};

// ── Backends ──────────────────────────────────────────────────────────────────

function copilot(args: string[]) {
  return launch({
    ...COMMON_ENV,
    ANTHROPIC_BASE_URL: "http://localhost:4141",
    ANTHROPIC_AUTH_TOKEN: "dummy",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
    CLAUDE_CONFIG_DIR: `${HOME}/.ccc`,
  }, { ...TAVILY_MCP }, args);
}

function ds(args: string[]) {
  const deepseekKey = vaultGet("deepseek_key");
  return launch({
    ...COMMON_ENV,
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: deepseekKey,
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    CLAUDE_CONFIG_DIR: `${HOME}/.ccds`,
  }, { ...TAVILY_MCP }, args);
}

function mimo(args: string[]) {
  const mimoKey = vaultGet("mimo_token_plan_token")
  return launch({
    ...COMMON_ENV,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
    ANTHROPIC_BASE_URL: "https://token-plan-cn.xiaomimimo.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: mimoKey,
    ANTHROPIC_DEFAULT_SONNET_MODEL: "mimo-v2.5-pro[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "mimo-v2.5-pro[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "mimo-v2.5",
    CLAUDE_CONFIG_DIR: `${HOME}/.mimo`,
  }, { ...TAVILY_MCP }, args);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [backend, ...rest] = process.argv.slice(2);

switch (backend) {
  case "copilot": await copilot(rest); break;
  case "ds":      await ds(rest); break;
  case "mimo":    await mimo(rest); break;
  default:
    console.error(`Usage: ax.ts cc <copilot|ds|mimo> [claude args...]`);
    process.exit(1);
}
