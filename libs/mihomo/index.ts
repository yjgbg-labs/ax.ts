#!/usr/bin/env bun
import { join } from "node:path";

const ROUTER = "root@10.0.0.1";
const REMOTE_CONF = "/etc/mihomo/config.yaml";
const SERVICE = "/etc/init.d/mihomo";

// ── SSH helpers ───────────────────────────────────────────────────────────────

function ssh(cmd: string): string {
  const r = Bun.spawnSync(["ssh", ROUTER, cmd], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim() || "ssh command failed");
  return r.stdout.toString().trim();
}

function sshRaw(cmd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: ssh(cmd) };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

function status() {
  const running = sshRaw(`${SERVICE} running`);
  const isRunning = running.ok;
  const pid = isRunning ? sshRaw("pgrep -f '/usr/bin/mihomo -d'").out : null;

  console.log(`Mihomo: ${isRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[31mstopped\x1b[0m"}`);
  if (pid) {
    console.log(`PID:    ${pid}`);
    const mem = sshRaw(`cat /proc/${pid}/status 2>/dev/null | grep VmRSS`);
    if (mem.ok) console.log(`Memory: ${mem.out.replace(/^VmRSS:\s*/, "")}`);
    const startTs = sshRaw(`stat -c %Y /proc/${pid} 2>/dev/null`);
    const now = sshRaw("date +%s");
    if (startTs.ok && now.ok) {
      const secs = parseInt(now.out) - parseInt(startTs.out);
      const d = Math.floor(secs / 86400);
      const h = Math.floor((secs % 86400) / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const parts: string[] = [];
      if (d) parts.push(`${d}d`);
      if (h) parts.push(`${h}h`);
      parts.push(`${m}m`);
      console.log(`Uptime: ${parts.join(" ")}`);
    }
  }

  const enabled = sshRaw(`${SERVICE} enabled`);
  console.log(`Boot:   ${enabled.ok ? "enabled" : "disabled"}`);
}

function start() {
  if (sshRaw(`${SERVICE} running`).ok) { console.log("Mihomo is already running."); return; }
  console.log("Starting mihomo...");
  ssh(`${SERVICE} start`);
  console.log("\x1b[32mStarted.\x1b[0m");
}

function stop() {
  if (!sshRaw(`${SERVICE} running`).ok) { console.log("Mihomo is already stopped."); return; }
  console.log("Stopping mihomo...");
  ssh(`${SERVICE} stop`);
  console.log("\x1b[31mStopped.\x1b[0m");
}

function restart() {
  console.log("Restarting mihomo...");
  ssh(`${SERVICE} restart`);
  console.log("\x1b[32mRestarted.\x1b[0m");
}

function cleanup(file: string, dir: string) {
  try { Bun.spawnSync(["rm", "-f", file]); } catch {}
  try { Bun.spawnSync(["rmdir", dir]); } catch {}
}

function read() {
  process.stdout.write(ssh(`cat ${REMOTE_CONF}`));
}

async function write(localFile: string) {
  const content = await Bun.file(localFile).text();
  if (!content.includes(":")) {
    console.error("Invalid YAML (no key-value pairs found), aborting.");
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  ssh(`cp ${REMOTE_CONF} ${REMOTE_CONF}.bak.${ts}`);
  Bun.spawnSync(["scp", "-q", localFile, `${ROUTER}:${REMOTE_CONF}`]);

  console.log("Restarting mihomo...");
  ssh(`${SERVICE} restart`);
  console.log("\x1b[32mConfig applied and mihomo restarted.\x1b[0m");
}

async function edit() {
  const tmpDir = `/tmp/mihomo-${crypto.randomUUID().slice(0, 8)}`;
  Bun.spawnSync(["mkdir", "-p", tmpDir]);
  const tmpFile = join(tmpDir, "config.yaml");

  Bun.spawnSync(["scp", "-q", `${ROUTER}:${REMOTE_CONF}`, tmpFile]);
  const before = await Bun.file(tmpFile).text();

  const editor = process.env.EDITOR || "vim";
  const child = Bun.spawn([editor, tmpFile], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;

  if (code !== 0) {
    console.error(`Editor exited with code ${code}, aborting.`);
    cleanup(tmpFile, tmpDir);
    process.exit(1);
  }

  const after = await Bun.file(tmpFile).text();
  if (after === before) {
    console.log("No changes made, skipping upload.");
    cleanup(tmpFile, tmpDir);
    return;
  }

  if (!after.includes(":")) {
    console.error("Invalid YAML (no key-value pairs found), aborting.");
    cleanup(tmpFile, tmpDir);
    process.exit(1);
  }

  console.log("Backing up and uploading new config...");
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  ssh(`cp ${REMOTE_CONF} ${REMOTE_CONF}.bak.${ts}`);
  Bun.spawnSync(["scp", "-q", tmpFile, `${ROUTER}:${REMOTE_CONF}`]);

  console.log("Restarting mihomo...");
  ssh(`${SERVICE} restart`);
  console.log("\x1b[32mConfig applied and mihomo restarted.\x1b[0m");
  cleanup(tmpFile, tmpDir);
}

async function logs(n = 50, follow = false) {
  const cmd = follow ? "logread -f -e mihomo" : `logread -e mihomo | tail -${n}`;
  const proc = Bun.spawn(["ssh", ROUTER, cmd], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  await proc.exited;
}

function usage() {
  console.log(`Usage: mihomo <command>

Commands:
  status, st      显示 mihomo 运行状态
  start, up       启动 mihomo 服务
  stop, down      停止 mihomo 服务
  restart, rs     重启 mihomo 服务
  read, r         输出 config.yaml 到 stdout
  write, w <file> 从本地文件上传 config 并重启
  edit, e         编辑 config.yaml（类似 kubectl edit）
  logs [N]        显示最近 N 行日志（默认 50）
  logs -f         实时追踪日志
  help            显示此帮助`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "status":  case "st":   status(); break;
      case "start":   case "up":   start(); break;
      case "stop":    case "down": stop(); break;
      case "restart": case "rs":   restart(); break;
      case "read":    case "r":    read(); break;
      case "write":   case "w":    {
        if (!args[0]) { console.error("Usage: mihomo write <file>"); process.exit(1); }
        await write(args[0]); break;
      }
      case "edit":    case "e":    await edit(); break;
      case "logs":    case "log":  case "l": {
        const follow = args.includes("-f");
        const num = parseInt(args.find(a => a !== "-f") ?? "") || 50;
        await logs(num, follow);
        break;
      }
      case "help": case "-h": case "--help": usage(); break;
      default:
        if (!cmd) { usage(); } else { console.error(`Unknown command: ${cmd}`); usage(); process.exit(1); }
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
