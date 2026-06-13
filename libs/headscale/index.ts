#!/usr/bin/env bun

import { readFileSync, writeFileSync, existsSync } from "fs";
import { getEntry, totp } from "../vault/index.ts";

const HEADSCALE_SERVER = "https://headscale.yjgbg.com:28443";
const API_BASE = "http://49.235.170.57:9100";
const VAULT_KEY = "headscale_mfa";

// ── Helpers ────────────────────────────────────────────────────────────────────

function run(cmd: string[], opts?: { sudo?: boolean }): { ok: boolean; stdout: string; stderr: string } {
  const args = opts?.sudo ? ["sudo", ...cmd] : cmd;
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
}

function tailscalePath(): string | null {
  const r = run(["which", "tailscale"]);
  return r.ok ? r.stdout : null;
}

function getUser(): string {
  return process.env.USER || "root";
}

const SUDOERS_LINE = `${getUser()} ALL=(ALL) NOPASSWD: /usr/bin/tailscale`;

function hasSudoersLine(): boolean {
  const r = run(["sudo", "-n", "grep", "-qF", SUDOERS_LINE, "/etc/sudoers"]);
  return r.ok;
}

function addSudoersLine(): void {
  run(["bash", "-c", `echo ${JSON.stringify(SUDOERS_LINE)} | sudo tee -a /etc/sudoers > /dev/null`]);
  run(["sudo", "visudo", "-cf", "/etc/sudoers"]);
}

function removeSudoersLine(): void {
  const escaped = SUDOERS_LINE.replace(/\//g, "\\/");
  run(["sudo", "sed", "-i", `/${escaped}/d`, "/etc/sudoers"]);
  run(["sudo", "visudo", "-cf", "/etc/sudoers"]);
}

async function readMFA(): Promise<string> {
  // 尝试从 vault 获取
  try {
    const entry = await getEntry(VAULT_KEY);
    if (entry.type === "totp") {
      return await totp(entry.value);
    }
  } catch {}

  // 手动输入
  const stdin = process.stdin;
  if (stdin.isTTY) {
    return new Promise((resolve) => {
      process.stderr.write("请输入 6 位 MFA 动态码: ");
      stdin.setRawMode(true);
      stdin.resume();
      let buf = "";
      const cleanup = () => { stdin.setRawMode(false); stdin.pause(); };
      stdin.on("data", function onData(chunk: Buffer) {
        for (const byte of chunk) {
          if (byte === 0x03) { cleanup(); process.stderr.write("\n"); process.exit(1); }
          if (byte === 0x0d || byte === 0x0a) {
            cleanup();
            process.stderr.write("\n");
            stdin.removeListener("data", onData);
            resolve(buf);
            return;
          }
          if (byte === 0x7f || byte === 0x08) { buf = buf.slice(0, -1); process.stderr.write("\b \b"); continue; }
          if (byte < 0x20) continue;
          buf += String.fromCharCode(byte);
          process.stderr.write("*");
        }
      });
    });
  } else {
    return (await new Response(stdin).text()).trim();
  }
}

// ── install ────────────────────────────────────────────────────────────────────

async function cmdInstall() {
  if (!tailscalePath()) {
    process.stdout.write("安装 tailscale... ");
    const r = run(["bash", "-c", "curl -fsSL https://tailscale.com/install.sh | sh"], { sudo: true });
    if (!r.ok) throw new Error(`安装失败: ${r.stderr}`);
    console.log("done");
  }

  const ver = run(["tailscale", "version"]);
  console.log(`✓ tailscale ${ver.stdout.split("\n")[0]}`);

  process.stdout.write("配置 sudo 免密... ");
  if (hasSudoersLine()) {
    console.log("已存在");
  } else {
    addSudoersLine();
    console.log("done");
  }
}

// ── uninstall ──────────────────────────────────────────────────────────────────

function cmdUninstall() {
  process.stdout.write("断开 VPN 连接... ");
  if (tailscalePath()) run(["tailscale", "logout"]);
  console.log("done");

  process.stdout.write("停止 tailscaled 服务... ");
  run(["sudo", "systemctl", "stop", "tailscaled"]);
  run(["sudo", "systemctl", "disable", "tailscaled"]);
  console.log("done");

  process.stdout.write("清理本地数据... ");
  const dirs = ["/var/lib/tailscale", "/etc/tailscale"];
  for (const d of dirs) {
    if (existsSync(d)) {
      const r = run(["sudo", "rm", "-rf", d]);
      if (!r.ok) throw new Error(`删除 ${d} 失败: ${r.stderr}`);
    }
  }
  console.log("done");

  process.stdout.write("清理 sudo 免密配置... ");
  if (hasSudoersLine()) {
    removeSudoersLine();
  }
  console.log("done");

  process.stdout.write("卸载 tailscale... ");
  const os = run(["bash", "-c", "cat /etc/os-release | head -1"]);
  if (os.stdout.includes("Debian") || os.stdout.includes("Ubuntu")) {
    run(["sudo", "apt-get", "remove", "-y", "tailscale"]);
  } else {
    run(["sudo", "yum", "remove", "-y", "tailscale"]);
  }
  console.log("done");
  console.log("✓ tailscale 已卸载");
}

// ── health ─────────────────────────────────────────────────────────────────────

function cmdHealth() {
  console.log("=== tailscale ===");

  const tsPath = tailscalePath();
  if (!tsPath) {
    console.log("状态: 未安装");
    console.log("\n=== headscale 服务器 ===");
    checkServer();
    return;
  }

  const status = run([tsPath, "status"]);
  if (!status.ok) {
    console.log("状态: 未连接");
    console.log(`  ${status.stderr}`);
  } else {
    console.log("状态: 已连接");
    for (const line of status.stdout.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  console.log("\n=== headscale 服务器 ===");
  checkServer();
}

function checkServer() {
  process.stdout.write("API 连通性... ");
  const r = run(["curl", "-s", "--connect-timeout", "3", `${API_BASE}/health`]);
  console.log(r.ok && r.stdout.includes('"ok"') ? "正常" : "异常");
}

// ── connect ────────────────────────────────────────────────────────────────────

const SOCKET_PATH = "/var/run/tailscale/tailscaled.sock";
const STATE_FILE = "/var/lib/tailscale/tailscaled.state";

function waitForTailscaled(tsPath: string, timeoutMs = 10000): void {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(SOCKET_PATH)) return;
    Bun.sleepSync(200);
  }
  throw new Error("tailscaled 启动超时");
}

function hasExistingState(): boolean {
  return existsSync(STATE_FILE);
}

async function cmdConnect() {
  const tsPath = tailscalePath();
  if (!tsPath) throw new Error("tailscale 未安装，请先运行: ax.ts headscale install");

  // 检查是否已连接（tailscale status exitCode=0 且输出非空说明已连接）
  const status = run([tsPath, "status"]);
  if (status.ok && status.stdout.length > 0) {
    console.log("已连接到 VPN:");
    for (const line of status.stdout.split("\n")) console.log(`  ${line}`);
    return;
  }

  // 确保 tailscaled 在运行
  if (!existsSync(SOCKET_PATH)) {
    process.stdout.write("启动 tailscaled... ");
    run(["sudo", "systemctl", "start", "tailscaled"]);
    waitForTailscaled(tsPath);
    console.log("done");
  }

  // 已有本地状态，直接重连
  if (hasExistingState()) {
    process.stdout.write("重新连接... ");
    const r = run([tsPath, "up", "--reset", `--login-server=${HEADSCALE_SERVER}`], { sudo: true });
    if (r.ok) {
      console.log("done\n");
      console.log("✓ 已重新连接 VPN");
      const s = run([tsPath, "status"]);
      if (s.ok) console.log(s.stdout);
      return;
    }
    console.log("需要认证");
  }

  // 1. 获取 MFA 动态码
  process.stdout.write("获取 MFA 动态码... ");
  let mfa = await readMFA();
  if (!/^\d{6}$/.test(mfa)) {
    console.error("\nmfa 必须是 6 位数字");
    process.exit(1);
  }
  console.log("done");

  // 2. 调 API 签发 preauth key
  process.stdout.write("签发 preauth key... ");
  const res = await fetch(`${API_BASE}/api/preauth-key?mfa=${mfa}`, { method: "POST" });
  const data = await res.json() as any;
  if (!res.ok || !data.key) throw new Error(`签发失败: ${data.error || "unknown error"}`);
  console.log("done");

  // 3. tailscale up
  process.stdout.write("加入网络... ");
  const r = run([tsPath, "up", `--login-server=${HEADSCALE_SERVER}`, `--authkey=${data.key}`], { sudo: true });
  if (!r.ok) throw new Error(`加入失败: ${r.stderr}`);

  process.stdout.write("设置操作权限... ");
  run(["sudo", tsPath, "set", `--operator=${getUser()}`]);
  console.log("done\n");
  console.log("✓ 已加入 VPN 网络");

  const s = run([tsPath, "status"]);
  if (s.ok) console.log(s.stdout);
}

// ── disconnect ─────────────────────────────────────────────────────────────────

function cmdDisconnect() {
  const tsPath = tailscalePath();
  if (!tsPath) { console.log("tailscale 未安装"); return; }

  process.stdout.write("断开 VPN 连接... ");
  const r = run([tsPath, "logout"]);
  if (!r.ok) throw new Error(`断开失败: ${r.stderr}`);
  console.log("done");

  process.stdout.write("停止 tailscaled... ");
  run(["sudo", "systemctl", "stop", "tailscaled"]);
  console.log("done");

  console.log("✓ 已断开 VPN 连接");
}

// ── Main ───────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage: ax.ts headscale <command>

  管理 tailscale 客户端和 headscale VPN 连接

Commands:
  install     安装 tailscale
  uninstall   卸载 tailscale
  health      查看连接状态
  connect     连接到 VPN（自动签发 preauth key）
  disconnect  断开 VPN 连接`);
}

const [cmd] = process.argv.slice(2);

try {
  switch (cmd) {
    case "install":    await cmdInstall(); break;
    case "uninstall":  cmdUninstall(); break;
    case "health":     cmdHealth(); break;
    case "connect":    await cmdConnect(); break;
    case "disconnect": cmdDisconnect(); break;
    case "-h":
    case "--help":
    case undefined:
      usage();
      break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      usage();
      process.exit(1);
  }
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
}
