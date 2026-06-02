#!/usr/bin/env bun
import { readdir, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const LIBS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEMD_USER_DIR = resolve(homedir(), ".config/systemd/user");
const UNIT_PREFIX = "ax-";

interface ServiceDef {
  name: string;
  unitName: string;
  description: string;
  exec: string;
  env: Record<string, string>;
  restart: string;
  restartSec: number;
  workingDirectory?: string;
}

interface PackageService {
  exec: string;
  description?: string;
  env?: Record<string, string>;
  restart?: string;
  restartSec?: number;
  workingDirectory?: string;
}

async function discover(): Promise<ServiceDef[]> {
  const out: ServiceDef[] = [];
  const entries = await readdir(LIBS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const pkgFile = Bun.file(resolve(LIBS_DIR, entry.name, "package.json"));
    if (!(await pkgFile.exists())) continue;
    const pkg = (await pkgFile.json()) as {
      name?: string;
      description?: string;
      service?: PackageService;
    };
    const svc = pkg.service;
    if (!svc?.exec) continue;
    const name = pkg.name ?? entry.name;
    out.push({
      name,
      unitName: `${UNIT_PREFIX}${name}.service`,
      description: svc.description ?? pkg.description ?? name,
      exec: svc.exec,
      env: svc.env ?? {},
      restart: svc.restart ?? "always",
      restartSec: svc.restartSec ?? 5,
      workingDirectory: svc.workingDirectory ?? resolve(LIBS_DIR, entry.name),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function renderUnit(svc: ServiceDef): string {
  const lines: (string | null)[] = [
    "[Unit]",
    `Description=${svc.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    svc.workingDirectory ? `WorkingDirectory=${svc.workingDirectory}` : null,
    `ExecStart=/usr/bin/env ${svc.exec}`,
    `Restart=${svc.restart}`,
    `RestartSec=${svc.restartSec}`,
    "Environment=HOME=%h",
    "Environment=XDG_DATA_HOME=%h/.local/share",
    "Environment=PATH=%h/.bun/bin:%h/.local/share/fnm/fnm:%h/.local/share/fnm/aliases/default/bin:/usr/local/bin:/usr/bin:/bin",
    ...Object.entries(svc.env).map(([k, v]) => `Environment=${k}=${v}`),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

interface SctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function sctl(args: string[], capture = false): Promise<SctlResult> {
  const proc = Bun.spawn(["systemctl", "--user", ...args], {
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const code = await proc.exited;
  const stdout = capture ? await new Response(proc.stdout).text() : "";
  const stderr = capture ? await new Response(proc.stderr).text() : "";
  return { code, stdout, stderr };
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function pickService(services: ServiceDef[], name: string | undefined): ServiceDef {
  if (!name) fail("service name required");
  const svc = services.find((s) => s.name === name);
  if (!svc) {
    fail(
      `Unknown service: ${name}\nAvailable: ${services.map((s) => s.name).join(", ") || "(none)"}`,
    );
  }
  return svc;
}

async function cmdList(services: ServiceDef[]): Promise<number> {
  if (services.length === 0) {
    console.log("No services declared. Add a `service` field in libs/*/package.json.");
    return 0;
  }
  const nameW = Math.max(4, ...services.map((s) => s.name.length));
  const header = `${"NAME".padEnd(nameW)}  INSTALLED  ACTIVE    ENABLED   DESCRIPTION`;
  console.log(header);
  for (const svc of services) {
    const unitPath = resolve(SYSTEMD_USER_DIR, svc.unitName);
    const installed = existsSync(unitPath);
    let active = "-";
    let enabled = "-";
    if (installed) {
      active = (await sctl(["is-active", svc.unitName], true)).stdout.trim() || "?";
      enabled = (await sctl(["is-enabled", svc.unitName], true)).stdout.trim() || "?";
    }
    console.log(
      `${svc.name.padEnd(nameW)}  ${(installed ? "yes" : "no").padEnd(9)}  ${active.padEnd(8)}  ${enabled.padEnd(8)}  ${svc.description}`,
    );
  }
  return 0;
}

async function cmdEnable(svc: ServiceDef): Promise<number> {
  await mkdir(SYSTEMD_USER_DIR, { recursive: true });
  const unitPath = resolve(SYSTEMD_USER_DIR, svc.unitName);
  await writeFile(unitPath, renderUnit(svc));
  console.log(`wrote ${unitPath}`);
  let r = await sctl(["daemon-reload"]);
  if (r.code !== 0) return r.code;
  r = await sctl(["enable", svc.unitName]);
  return r.code;
}

async function cmdDisable(svc: ServiceDef): Promise<number> {
  const unitPath = resolve(SYSTEMD_USER_DIR, svc.unitName);
  if (!existsSync(unitPath)) {
    console.log(`${svc.unitName} not installed`);
    return 0;
  }
  await sctl(["disable", "--now", svc.unitName]);
  await unlink(unitPath);
  console.log(`removed ${unitPath}`);
  const r = await sctl(["daemon-reload"]);
  return r.code;
}

const HELP = `Usage: ax.ts service <subcommand> [name]

Subcommands:
  list                    列出所有发现的服务及其状态
  enable <name>           安装为 user-level systemd unit 并 enable
  disable <name>          停止、disable 并删除 unit 文件
  start <name>            systemctl --user start
  stop <name>             systemctl --user stop
  restart <name>          systemctl --user restart
  status <name>           systemctl --user status
  logs <name> [args...]   journalctl --user -u <unit>（默认 -n 200，附加参数透传，如 -f / --since '1h ago'）

服务通过扫描 libs/*/package.json 中的 \`service\` 字段发现。
生成的 unit 命名为 ${UNIT_PREFIX}<name>.service。
`;

async function main() {
  const [sub, name, ...rest] = process.argv.slice(2);
  if (!sub || sub === "-h" || sub === "--help") {
    console.log(HELP);
    process.exit(sub ? 0 : 1);
  }

  const services = await discover();

  switch (sub) {
    case "list":
      process.exit(await cmdList(services));
    case "enable":
      process.exit(await cmdEnable(pickService(services, name)));
    case "disable":
      process.exit(await cmdDisable(pickService(services, name)));
    case "start":
    case "stop":
    case "restart":
    case "status": {
      const svc = pickService(services, name);
      const r = await sctl([sub, svc.unitName]);
      process.exit(r.code);
    }
    case "logs": {
      const svc = pickService(services, name);
      const args = rest.length === 0 ? ["-n", "200"] : rest;
      const proc = Bun.spawn(
        ["journalctl", "--user", "-u", svc.unitName, ...args],
        { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      );
      process.exit(await proc.exited);
    }
    default:
      fail(`Unknown subcommand: ${sub}\n\n${HELP}`);
  }
}

main();
