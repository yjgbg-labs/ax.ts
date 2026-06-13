// 配置与设备身份：UDN 持久化、友好名、端口、LAN IP 探测
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, hostname, networkInterfaces } from "node:os";

export const HTTP_PORT = Number(process.env.DLNA_HTTP_PORT ?? 8200);
export const BRIDGE_PORT = Number(process.env.DLNA_BRIDGE_PORT ?? 8201);
export const SSDP_PORT = 1900;
export const SSDP_ADDR = "239.255.255.250";

export const FRIENDLY_NAME =
  process.env.DLNA_NAME ?? `Windows 屏幕 (${hostname()})`;
export const MANUFACTURER = "ax";
export const MODEL_NAME = "ax-dlna";

const STATE_DIR = resolve(homedir(), ".local/share/ax-dlna");

// UDN 必须跨重启稳定，否则控制点会把渲染器当成新设备
export function getUDN(): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const f = resolve(STATE_DIR, "udn");
  if (existsSync(f)) {
    const v = readFileSync(f, "utf8").trim();
    if (v) return v;
  }
  const udn = `uuid:${randomUUID()}`;
  writeFileSync(f, udn);
  return udn;
}

// 选 LAN IP：mirrored WSL 下 eth0 即物理网卡。优先非内部 IPv4，排除 172.x WSL 虚拟网段
export function getLanIP(): string {
  if (process.env.DLNA_IP) return process.env.DLNA_IP;
  const ifaces = networkInterfaces();
  const cands: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      cands.push(a.address);
    }
  }
  // 偏好 10.x / 192.168.x，最后才考虑 172.x
  cands.sort((a, b) => rank(a) - rank(b));
  return cands[0] ?? "127.0.0.1";
}

function rank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (ip.startsWith("172.")) return 3; // 可能是 WSL 虚拟网段，靠后
  return 2;
}

export const STATE_DIR_PATH = STATE_DIR;
