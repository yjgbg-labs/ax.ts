// WSL 侧播放控制：拉起 Windows 桥接进程，通过 localhost TCP 把 DLNA 动作映射到 mpv
import net from "node:net";
import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_PORT } from "./config";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SRC = resolve(HERE, "bridge.ps1");
const BRIDGE_WIN = "C:\\Windows\\Temp\\ax-dlna-bridge.ps1";
const BRIDGE_WIN_WSL = "/mnt/c/Windows/Temp/ax-dlna-bridge.ps1";
const PIPE_NAME = "ax-dlna-mpv";

// systemd 服务的 PATH 不含 Windows 目录，必须用绝对路径调 powershell（交互 shell 靠 interop 自动加 PATH，服务里没有）
const PWSH =
  process.env.DLNA_PWSH ??
  ["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe"].find(
    (p) => existsSync(p),
  ) ??
  "powershell.exe";

export interface Position {
  positionSec: number;
  durationSec: number;
  paused: boolean;
  idle: boolean;
}

export class Player {
  private bridgeProc?: ReturnType<typeof Bun.spawn>;
  private sock?: net.Socket;
  private rid = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private mpvPath = "mpv";
  private starting?: Promise<void>;

  async ensureBridge(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async _start(): Promise<void> {
    this.mpvPath = await resolveMpvPath();
    copyFileSync(BRIDGE_SRC, BRIDGE_WIN_WSL);
    // 已在跑就复用，避免重复 listener（端口占用）
    if (!(await this.ping())) {
      await this.killStrayBridges(); // 没有活的 bridge → 清掉可能半死的残留，再起新的
      this.bridgeProc = Bun.spawn(
        [
          PWSH,
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          BRIDGE_WIN,
          "-Port",
          String(BRIDGE_PORT),
          "-PipeName",
          PIPE_NAME,
          "-MpvPath",
          this.mpvPath,
        ],
        { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
      );
      // 等待 listener 起来
      for (let i = 0; i < 40 && !(await this.ping()); i++) {
        await sleep(150);
      }
    }
    await this.connect();
  }

  private ping(): Promise<boolean> {
    return new Promise((res) => {
      const s = net.connect(BRIDGE_PORT, "127.0.0.1");
      const done = (ok: boolean) => {
        s.destroy();
        res(ok);
      };
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
      setTimeout(() => done(false), 500);
    });
  }

  // 清掉残留的 bridge 进程（仅在没有活的 bridge 时调用）。用 *-File*…ps1* 精确匹配，避免误杀查询进程自身
  private async killStrayBridges(): Promise<void> {
    const ps =
      "Get-CimInstance Win32_Process -Filter \"name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*ax-dlna-bridge.ps1*' -and $_.CommandLine -notlike '*-Command*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    try {
      const p = Bun.spawn([PWSH, "-NoProfile", "-Command", ps], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await p.exited;
    } catch {}
  }

  private connect(): Promise<void> {
    return new Promise((res, rej) => {
      const s = net.connect(BRIDGE_PORT, "127.0.0.1");
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.sock = s;
        res();
      });
      s.once("error", rej);
      s.on("close", () => {
        if (this.sock === s) this.sock = undefined;
      });
    });
  }

  // 串行发送一行，读回一行（桥接保证一行命令对一行响应）
  private send(obj: unknown): Promise<any> {
    const run = async (): Promise<any> => {
      await this.ensureBridge();
      const sock = this.sock!;
      const line = JSON.stringify(obj) + "\n";
      return await new Promise<any>((res) => {
        let buf = "";
        const onData = (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            sock.removeListener("data", onData);
            const resp = buf.slice(0, nl);
            try {
              res(JSON.parse(resp));
            } catch {
              res({ raw: resp });
            }
          }
        };
        sock.on("data", onData);
        sock.write(line);
        setTimeout(() => {
          sock.removeListener("data", onData);
          res({ error: "timeout" });
        }, 5000);
      });
    };
    // 串行化
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private mpv(command: unknown[]): Promise<any> {
    const request_id = this.rid++;
    return this.send({ command, request_id });
  }

  // ---- 高层动作 ----

  async load(url: string): Promise<void> {
    await this.send({ _bridge: "load", url });
  }

  async play(): Promise<void> {
    await this.mpv(["set_property", "pause", false]);
  }

  async pause(): Promise<void> {
    await this.mpv(["set_property", "pause", true]);
  }

  async stop(): Promise<void> {
    await this.send({ _bridge: "quit" });
  }

  async seek(sec: number): Promise<void> {
    await this.mpv(["seek", sec, "absolute"]);
  }

  async setVolume(pct: number): Promise<void> {
    await this.mpv(["set_property", "volume", Math.max(0, Math.min(100, pct))]);
  }

  async setMute(on: boolean): Promise<void> {
    await this.mpv(["set_property", "mute", on]);
  }

  async getPosition(): Promise<Position> {
    const [pos, dur, paused, idle, eof] = await Promise.all([
      this.prop("time-pos"),
      this.prop("duration"),
      this.prop("pause"),
      this.prop("idle-active"),
      this.prop("eof-reached"),
    ]);
    return {
      positionSec: num(pos),
      durationSec: num(dur),
      paused: paused === true,
      idle: idle === true || eof === true,
    };
  }

  private async prop(name: string): Promise<any> {
    const r = await this.mpv(["get_property", name]);
    return r?.error === "success" ? r.data : undefined;
  }

  shutdown(): void {
    // 同步清掉 Windows 侧 bridge + mpv，避免 service stop/restart 后残留（bridge 是分离进程，不会随 renderer 退出）
    const ps =
      "Get-Process mpv -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; " +
      "Get-CimInstance Win32_Process -Filter \"name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*ax-dlna-bridge.ps1*' -and $_.CommandLine -notlike '*-Command*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    try {
      this.sock?.destroy();
      Bun.spawnSync([PWSH, "-NoProfile", "-Command", ps]);
    } catch {}
  }
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 解析 Windows 上的 mpv.exe 路径（PATH → winget Links → winget Packages）
async function resolveMpvPath(): Promise<string> {
  const ps = `
    $fixed = @(
      'C:\\Program Files\\MPV Player\\mpv.exe',
      'C:\\Program Files\\mpv\\mpv.exe',
      (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links\\mpv.exe')
    )
    foreach ($p in $fixed) { if (Test-Path $p) { $p; exit } }
    $c = Get-Command mpv -ErrorAction SilentlyContinue
    if ($c) { $c.Source; exit }
    foreach ($base in @($env:LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)')) {
      $pkg = Get-ChildItem $base -Recurse -Filter mpv.exe -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($pkg) { $pkg.FullName; exit }
    }
    'mpv'
  `;
  const proc = Bun.spawn(
    [PWSH, "-NoProfile", "-Command", ps],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim().split(/\r?\n/).pop() || "mpv";
  return out.trim() || "mpv";
}
