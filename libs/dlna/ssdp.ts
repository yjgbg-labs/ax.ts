// SSDP：被动响应 M-SEARCH + 主动周期 NOTIFY alive，让控制点发现本渲染器
import dgram from "node:dgram";
import { SSDP_ADDR, SSDP_PORT, HTTP_PORT } from "./config";

const ALIVE_INTERVAL_MS = 30_000;
const MAX_AGE = 1800;

export class SSDPServer {
  private sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  private timer?: ReturnType<typeof setInterval>;
  private targets: string[];

  constructor(
    private udn: string, // uuid:xxxx
    private ip: string,
  ) {
    // 本设备对外公布的所有 NT/ST 目标
    this.targets = [
      "upnp:rootdevice",
      this.udn,
      "urn:schemas-upnp-org:device:MediaRenderer:1",
      "urn:schemas-upnp-org:service:AVTransport:1",
      "urn:schemas-upnp-org:service:RenderingControl:1",
      "urn:schemas-upnp-org:service:ConnectionManager:1",
    ];
  }

  private get location(): string {
    return `http://${this.ip}:${HTTP_PORT}/device.xml`;
  }

  private usn(target: string): string {
    return target === this.udn ? this.udn : `${this.udn}::${target}`;
  }

  start(): Promise<void> {
    return new Promise((resolveStart, reject) => {
      this.sock.on("error", reject);
      this.sock.on("message", (msg, rinfo) => this.onMessage(msg, rinfo));
      this.sock.bind(SSDP_PORT, () => {
        try {
          this.sock.addMembership(SSDP_ADDR);
          this.sock.setMulticastTTL(4);
        } catch (e) {
          console.error("[ssdp] addMembership failed:", e);
        }
        this.sock.removeListener("error", reject);
        this.sock.on("error", (e) => console.error("[ssdp]", e));
        this.alive();
        this.timer = setInterval(() => this.alive(), ALIVE_INTERVAL_MS);
        console.log(`[ssdp] advertising ${this.location}`);
        resolveStart();
      });
    });
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const text = msg.toString("utf8");
    if (!text.startsWith("M-SEARCH")) return;
    const st = /^ST:[ \t]*(.+)$/im.exec(text)?.[1]?.trim();
    const mx = Number(/^MX:[ \t]*(\d+)/im.exec(text)?.[1] ?? "1");
    if (!st) return;

    // 外部来源(非本机)的搜索 → 打日志，便于诊断手机能否发现
    if (rinfo.address !== this.ip && !rinfo.address.startsWith("127.")) {
      console.log(`[ssdp] M-SEARCH from ${rinfo.address} ST=${st}`);
    }

    const matched =
      st === "ssdp:all"
        ? this.targets
        : this.targets.filter((t) => t === st);
    if (matched.length === 0) return;

    // MX 内随机延迟后单播回应（规范要求，避免风暴）
    const delay = Math.min(Math.max(mx, 1), 5) * Math.random() * 1000;
    setTimeout(() => {
      for (const t of matched) this.sendResponse(t, rinfo);
    }, delay);
  }

  private sendResponse(target: string, rinfo: dgram.RemoteInfo): void {
    const lines = [
      "HTTP/1.1 200 OK",
      `CACHE-CONTROL: max-age=${MAX_AGE}`,
      "EXT:",
      `LOCATION: ${this.location}`,
      "SERVER: WSL/1.0 UPnP/1.0 ax-dlna/1.0",
      `ST: ${target}`,
      `USN: ${this.usn(target)}`,
      `BOOTID.UPNP.ORG: 1`,
      `CONFIGID.UPNP.ORG: 1`,
      "",
      "",
    ];
    const buf = Buffer.from(lines.join("\r\n"));
    this.sock.send(buf, rinfo.port, rinfo.address, (err) => {
      if (err) console.error(`[ssdp] sendResponse error to ${rinfo.address}:${rinfo.port}:`, err);
      else console.log(`[ssdp] → response to ${rinfo.address}:${rinfo.port} ST=${target}`);
    });
  }

  private alive(): void {
    for (const t of this.targets) this.notify(t, "ssdp:alive");
  }

  private notify(target: string, nts: string): void {
    const lines = [
      "NOTIFY * HTTP/1.1",
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      `CACHE-CONTROL: max-age=${MAX_AGE}`,
      `LOCATION: ${this.location}`,
      `NT: ${target}`,
      `NTS: ${nts}`,
      "SERVER: WSL/1.0 UPnP/1.0 ax-dlna/1.0",
      `USN: ${this.usn(target)}`,
      `BOOTID.UPNP.ORG: 1`,
      `CONFIGID.UPNP.ORG: 1`,
      "",
      "",
    ];
    const buf = Buffer.from(lines.join("\r\n"));
    this.sock.send(buf, SSDP_PORT, SSDP_ADDR, (err) => {
      if (err) console.error(`[ssdp] notify error for ${target}:`, err);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.targets) this.notify(t, "ssdp:byebye");
    try {
      this.sock.close();
    } catch {}
  }
}
