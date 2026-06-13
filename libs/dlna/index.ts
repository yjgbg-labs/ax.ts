#!/usr/bin/env bun
// ax-dlna：DLNA MediaRenderer(DMR)，把投射的媒体在 Windows 屏幕用 mpv 全屏播放
import { randomUUID } from "node:crypto";
import { SSDPServer } from "./ssdp";
import { Player } from "./player";
import {
  deviceXML,
  AVTRANSPORT_SCPD,
  RENDERINGCONTROL_SCPD,
  CONNECTIONMANAGER_SCPD,
  SINK_PROTOCOL_INFO,
  esc,
} from "./xml";
import { HTTP_PORT, getUDN, getLanIP, FRIENDLY_NAME } from "./config";

type TransportState = "STOPPED" | "PLAYING" | "PAUSED_PLAYBACK" | "TRANSITIONING" | "NO_MEDIA_PRESENT";

const state = {
  uri: "",
  metadata: "",
  title: "",
  transport: "NO_MEDIA_PRESENT" as TransportState,
  volume: 100,
  mute: false,
};

const player = new Player();

// ---------- SOAP 工具 ----------

function getArg(body: string, name: string): string {
  // 参数通常无命名空间前缀；非贪婪匹配，容忍属性
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i");
  const m = re.exec(body);
  return m ? xmlUnescape(m[1].trim()) : "";
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function soapResponse(service: string, action: string, args: Record<string, string>): string {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}Response></s:Body>
</s:Envelope>`;
}

function soapFault(code = "701", desc = "Action Failed"): Response {
  const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail>
</s:Fault></s:Body></s:Envelope>`;
  return xmlResp(xml, 500);
}

function xmlResp(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": 'text/xml; charset="utf-8"', "EXT": "" },
  });
}

function secToTime(s: number): string {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function timeToSec(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.some((n) => isNaN(n))) return 0;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}

function titleFromDIDL(meta: string): string {
  const m = /<dc:title>([\s\S]*?)<\/dc:title>/i.exec(meta);
  return m ? xmlUnescape(m[1]).trim() : "";
}

// ---------- AVTransport ----------

async function handleAVTransport(action: string, body: string): Promise<Response> {
  switch (action) {
    case "SetAVTransportURI": {
      state.uri = getArg(body, "CurrentURI");
      state.metadata = getArg(body, "CurrentURIMetaData");
      state.title = titleFromDIDL(state.metadata) || state.uri;
      if (!state.uri) return soapFault("716", "Resource not found");
      state.transport = "TRANSITIONING";
      console.log(`[av] SetAVTransportURI → ${state.title}`);
      await player.load(state.uri);
      state.transport = "PLAYING";
      return xmlResp(soapResponse("AVTransport", action, {}));
    }
    case "Play":
      await player.play();
      state.transport = "PLAYING";
      return xmlResp(soapResponse("AVTransport", action, {}));
    case "Pause":
      await player.pause();
      state.transport = "PAUSED_PLAYBACK";
      return xmlResp(soapResponse("AVTransport", action, {}));
    case "Stop":
      await player.stop();
      state.transport = "STOPPED";
      return xmlResp(soapResponse("AVTransport", action, {}));
    case "Seek": {
      const unit = getArg(body, "Unit");
      const target = getArg(body, "Target");
      if (unit === "REL_TIME" || unit === "ABS_TIME") {
        await player.seek(timeToSec(target));
      }
      return xmlResp(soapResponse("AVTransport", action, {}));
    }
    case "GetTransportInfo": {
      // 与 mpv 实况对账：播完/空闲则回 STOPPED
      let st: TransportState = state.transport;
      if (st === "PLAYING" || st === "PAUSED_PLAYBACK") {
        try {
          const pos = await player.getPosition();
          if (pos.idle) {
            st = "STOPPED";
            state.transport = "STOPPED";
          } else if (pos.paused && st !== "PAUSED_PLAYBACK") {
            st = "PAUSED_PLAYBACK";
          }
        } catch {}
      }
      return xmlResp(
        soapResponse("AVTransport", action, {
          CurrentTransportState: st,
          CurrentTransportStatus: "OK",
          CurrentSpeed: "1",
        }),
      );
    }
    case "GetPositionInfo": {
      let pos = { positionSec: 0, durationSec: 0 };
      try {
        const p = await player.getPosition();
        pos = p;
      } catch {}
      const dur = secToTime(pos.durationSec);
      const rel = secToTime(pos.positionSec);
      return xmlResp(
        soapResponse("AVTransport", action, {
          Track: "1",
          TrackDuration: dur,
          TrackMetaData: state.metadata || "NOT_IMPLEMENTED",
          TrackURI: state.uri,
          RelTime: rel,
          AbsTime: rel,
          RelCount: "2147483647",
          AbsCount: "2147483647",
        }),
      );
    }
    case "GetMediaInfo": {
      let dur = "0:00:00";
      try {
        dur = secToTime((await player.getPosition()).durationSec);
      } catch {}
      return xmlResp(
        soapResponse("AVTransport", action, {
          NrTracks: state.uri ? "1" : "0",
          MediaDuration: dur,
          CurrentURI: state.uri,
          CurrentURIMetaData: state.metadata || "NOT_IMPLEMENTED",
          NextURI: "",
          NextURIMetaData: "",
          PlayMedium: "NETWORK",
          RecordMedium: "NOT_IMPLEMENTED",
          WriteStatus: "NOT_IMPLEMENTED",
        }),
      );
    }
    case "GetDeviceCapabilities":
      return xmlResp(
        soapResponse("AVTransport", action, {
          PlayMedia: "NETWORK,HDD",
          RecMedia: "NOT_IMPLEMENTED",
          RecQualityModes: "NOT_IMPLEMENTED",
        }),
      );
    case "GetTransportSettings":
      return xmlResp(
        soapResponse("AVTransport", action, { PlayMode: "NORMAL", RecQualityMode: "NOT_IMPLEMENTED" }),
      );
    case "Next":
    case "Previous":
      return xmlResp(soapResponse("AVTransport", action, {}));
    default:
      return soapFault("401", "Invalid Action");
  }
}

// ---------- RenderingControl ----------

async function handleRendering(action: string, body: string): Promise<Response> {
  switch (action) {
    case "GetVolume":
      return xmlResp(soapResponse("RenderingControl", action, { CurrentVolume: String(state.volume) }));
    case "SetVolume": {
      state.volume = Number(getArg(body, "DesiredVolume")) || state.volume;
      await player.setVolume(state.volume);
      return xmlResp(soapResponse("RenderingControl", action, {}));
    }
    case "GetMute":
      return xmlResp(soapResponse("RenderingControl", action, { CurrentMute: state.mute ? "1" : "0" }));
    case "SetMute": {
      state.mute = getArg(body, "DesiredMute") === "1";
      await player.setMute(state.mute);
      return xmlResp(soapResponse("RenderingControl", action, {}));
    }
    case "ListPresets":
      return xmlResp(soapResponse("RenderingControl", action, { CurrentPresetNameList: "FactoryDefaults" }));
    default:
      return soapFault("401", "Invalid Action");
  }
}

// ---------- ConnectionManager ----------

function handleConnMgr(action: string): Response {
  switch (action) {
    case "GetProtocolInfo":
      return xmlResp(soapResponse("ConnectionManager", action, { Source: "", Sink: SINK_PROTOCOL_INFO }));
    case "GetCurrentConnectionIDs":
      return xmlResp(soapResponse("ConnectionManager", action, { ConnectionIDs: "0" }));
    case "GetCurrentConnectionInfo":
      return xmlResp(
        soapResponse("ConnectionManager", action, {
          RcsID: "0",
          AVTransportID: "0",
          ProtocolInfo: "",
          PeerConnectionManager: "",
          PeerConnectionID: "-1",
          Direction: "Input",
          Status: "OK",
        }),
      );
    default:
      return soapFault("401", "Invalid Action");
  }
}

// ---------- HTTP 服务 ----------

function serve(udn: string, ip: string): void {
  Bun.serve({
    port: HTTP_PORT,
    hostname: "0.0.0.0",
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path === "/device.xml") return xmlResp(deviceXML(udn));
      if (path === "/scpd/AVTransport.xml") return xmlResp(AVTRANSPORT_SCPD);
      if (path === "/scpd/RenderingControl.xml") return xmlResp(RENDERINGCONTROL_SCPD);
      if (path === "/scpd/ConnectionManager.xml") return xmlResp(CONNECTIONMANAGER_SCPD);

      // GENA 订阅：返回 SID + TIMEOUT，控制点多数靠轮询，事件最小实现
      if (method === "SUBSCRIBE") {
        return new Response(null, {
          status: 200,
          headers: {
            SID: `uuid:${randomUUID()}`,
            TIMEOUT: "Second-1800",
            "Content-Length": "0",
          },
        });
      }
      if (method === "UNSUBSCRIBE") return new Response(null, { status: 200 });

      if (method === "POST" && path.startsWith("/control/")) {
        const soapAction = (req.headers.get("SOAPACTION") || "").replace(/"/g, "");
        const action = soapAction.split("#")[1] || "";
        const body = await req.text();
        try {
          if (path === "/control/AVTransport") return await handleAVTransport(action, body);
          if (path === "/control/RenderingControl") return await handleRendering(action, body);
          if (path === "/control/ConnectionManager") return handleConnMgr(action);
        } catch (e) {
          console.error(`[soap] ${action} error:`, e);
          return soapFault();
        }
      }

      return new Response("ax-dlna renderer", { status: 200 });
    },
  });
  console.log(`[http] http://${ip}:${HTTP_PORT}/device.xml`);
}

// ---------- 入口 ----------

async function main() {
  const sub = process.argv[2] ?? "serve";
  if (sub === "-h" || sub === "--help") {
    console.log(`Usage: ax.ts dlna <serve|status>

  serve    启动 DLNA 渲染器（默认）：SSDP 广播 + HTTP/SOAP，投射到 Windows mpv 全屏
  status   打印设备身份与监听地址

环境变量：
  DLNA_NAME         设备友好名（默认：Windows 屏幕 (hostname)）
  DLNA_HTTP_PORT    HTTP 端口（默认 8200）
  DLNA_BRIDGE_PORT  mpv 桥接 TCP 端口（默认 8201）
  DLNA_IP           对外 LAN IP（默认自动探测）

通过 ax.ts service enable dlna 装成常驻 systemd 服务。`);
    return;
  }

  const udn = getUDN();
  const ip = getLanIP();

  if (sub === "status") {
    console.log(`name:     ${FRIENDLY_NAME}`);
    console.log(`udn:      ${udn}`);
    console.log(`location: http://${ip}:${HTTP_PORT}/device.xml`);
    return;
  }

  console.log(`[dlna] ${FRIENDLY_NAME}`);
  console.log(`[dlna] udn=${udn} ip=${ip}`);
  serve(udn, ip);
  const ssdp = new SSDPServer(udn, ip);
  await ssdp.start();

  const shutdown = () => {
    console.log("\n[dlna] shutting down");
    ssdp.stop();
    player.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
