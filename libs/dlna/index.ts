#!/usr/bin/env bun
// ax-dlna: DLNA MediaRenderer — casts media to Windows screen via mpv fullscreen
import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { SSDPServer } from "./ssdp";
import { Player } from "./player";
import {
  deviceXML, AVTRANSPORT_SCPD, RENDERINGCONTROL_SCPD, CONNECTIONMANAGER_SCPD,
  SINK_PROTOCOL_INFO, esc,
} from "./xml";
import { HTTP_PORT, getUDN, getLanIP, FRIENDLY_NAME } from "./config";

type TransportState = "STOPPED" | "PLAYING" | "PAUSED_PLAYBACK" | "TRANSITIONING" | "NO_MEDIA_PRESENT";

const state = {
  uri: "", metadata: "", title: "",
  transport: "NO_MEDIA_PRESENT" as TransportState,
  volume: 100, mute: false,
};

const player = new Player();

// ---------- GENA events ----------

interface Sub { callback: string; sid: string; expires: number; seq: number; }
const subs = new Map<string, Sub[]>(); // service -> subscriptions

// The LastChange payload is a full Event document that must be XML-escaped once
// as text. Escaping the whole doc (not just the InstanceID wrapper) keeps the
// inner state-variable elements inside the escaped string, and the metadata
// namespace lets control points actually parse the change.
function lastChange(service: string, vars: Record<string, string>): string {
  const inner = Object.entries(vars).map(([k, v]) => `<${k} val="${esc(v)}"/>`).join("");
  const ns = service === "RenderingControl"
    ? "urn:schemas-upnp-org:metadata-1-0/RCS/"
    : "urn:schemas-upnp-org:metadata-1-0/AVT/";
  const evt = `<Event xmlns="${ns}"><InstanceID val="0">${inner}</InstanceID></Event>`;
  return `<LastChange>${esc(evt)}</LastChange>`;
}

async function fireEvent(service: string, vars: Record<string, string>) {
  const body = `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property>${
    lastChange(service, vars)
  }</e:property></e:propertyset>`;
  const now = Date.now();
  const alive = (subs.get(service) || []).filter((s) => s.expires > now);
  subs.set(service, alive);
  await Promise.all(alive.map((s) =>
    fetch(s.callback, {
      method: "NOTIFY",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        NT: "upnp:event", NTS: "upnp:propchange",
        SID: s.sid, SEQ: String(s.seq++),
      },
      body,
    }).catch(() => {}),
  ));
}

function notify(service: string, vars: Record<string, string>) {
  fireEvent(service, vars);
}

// ---------- SOAP helpers ----------

const soapParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, stopNodes: ["*.CurrentURIMetaData"] });

function getArg(body: string, name: string): string {
  try {
    const args = soapParser.parse(body)?.Envelope?.Body;
    if (!args || typeof args !== "object") return "";
    for (const key of Object.keys(args)) {
      const a = args[key];
      if (a && typeof a === "object" && name in a) {
        if (name === "CurrentURIMetaData" && typeof a[name] === "string") {
          // stopNodes keeps the DIDL-Lite raw (still entity-escaped); return the
          // bare DIDL document so state.metadata round-trips correctly.
          return a[name].startsWith("&") ? xmlUnescape(a[name]) : a[name];
        }
        return String(a[name] ?? "");
      }
    }
    return "";
  } catch { return ""; }
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function soapResp(service: string, action: string, args: Record<string, string>): string {
  const body = Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}Response></s:Body>
</s:Envelope>`;
}

function xmlResp(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": 'text/xml; charset="utf-8"', EXT: "", Connection: "close" },
  });
}

function soapFault(code = "701", desc = "Action Failed"): Response {
  return xmlResp(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail>
</s:Fault></s:Body></s:Envelope>`, 500);
}

function secToTime(s: number): string {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function timeToSec(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((s, p) => s * 60 + p, 0);
}

function titleFromDIDL(meta: string): string {
  const m = /<dc:title>([\s\S]*?)<\/dc:title>/i.exec(meta);
  return m?.[1] ? xmlUnescape(m[1]).trim() : "";
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
      notify("AVTransport", { TransportState: state.transport, AVTransportURI: state.uri, AVTransportURIMetaData: state.metadata || "NOT_IMPLEMENTED" });
      return xmlResp(soapResp("AVTransport", action, {}));
    }
    case "Play":
      await player.play();
      state.transport = "PLAYING";
      notify("AVTransport", { TransportState: state.transport });
      return xmlResp(soapResp("AVTransport", action, {}));
    case "Pause":
      await player.pause();
      state.transport = "PAUSED_PLAYBACK";
      notify("AVTransport", { TransportState: state.transport });
      return xmlResp(soapResp("AVTransport", action, {}));
    case "Stop":
      await player.stop();
      state.transport = "STOPPED";
      notify("AVTransport", { TransportState: state.transport });
      return xmlResp(soapResp("AVTransport", action, {}));
    case "Seek": {
      const unit = getArg(body, "Unit"), target = getArg(body, "Target");
      if (unit === "REL_TIME" || unit === "ABS_TIME") await player.seek(timeToSec(target));
      return xmlResp(soapResp("AVTransport", action, {}));
    }
    case "GetTransportInfo": {
      let st = state.transport;
      if (st === "PLAYING" || st === "PAUSED_PLAYBACK") {
        try {
          const pos = await player.getPosition();
          if (pos.idle) { st = "STOPPED"; state.transport = "STOPPED"; }
          else if (pos.paused && st !== "PAUSED_PLAYBACK") st = "PAUSED_PLAYBACK";
        } catch {}
      }
      return xmlResp(soapResp("AVTransport", action, {
        CurrentTransportState: st, CurrentTransportStatus: "OK", CurrentSpeed: "1",
      }));
    }
    case "GetPositionInfo": {
      let pos = { positionSec: 0, durationSec: 0 };
      try { pos = await player.getPosition(); } catch {}
      const time = secToTime(pos.positionSec);
      return xmlResp(soapResp("AVTransport", action, {
        Track: "1", TrackDuration: secToTime(pos.durationSec),
        TrackMetaData: state.metadata || "NOT_IMPLEMENTED", TrackURI: state.uri,
        RelTime: time, AbsTime: time, RelCount: "2147483647", AbsCount: "2147483647",
      }));
    }
    case "GetMediaInfo": {
      let dur = "0:00:00";
      try { dur = secToTime((await player.getPosition()).durationSec); } catch {}
      return xmlResp(soapResp("AVTransport", action, {
        NrTracks: state.uri ? "1" : "0", MediaDuration: dur,
        CurrentURI: state.uri, CurrentURIMetaData: state.metadata || "NOT_IMPLEMENTED",
        NextURI: "", NextURIMetaData: "", PlayMedium: "NETWORK",
        RecordMedium: "NOT_IMPLEMENTED", WriteStatus: "NOT_IMPLEMENTED",
      }));
    }
    case "GetDeviceCapabilities":
      return xmlResp(soapResp("AVTransport", action, {
        PlayMedia: "NETWORK,HDD", RecMedia: "NOT_IMPLEMENTED", RecQualityModes: "NOT_IMPLEMENTED",
      }));
    case "GetTransportSettings":
      return xmlResp(soapResp("AVTransport", action, { PlayMode: "NORMAL", RecQualityMode: "NOT_IMPLEMENTED" }));
    case "Next":
    case "Previous":
      return xmlResp(soapResp("AVTransport", action, {}));
    default:
      return soapFault("401", "Invalid Action");
  }
}

// ---------- RenderingControl ----------

async function handleRendering(action: string, body: string): Promise<Response> {
  switch (action) {
    case "GetVolume":
      return xmlResp(soapResp("RenderingControl", action, { CurrentVolume: String(state.volume) }));
    case "SetVolume": {
      state.volume = Number(getArg(body, "DesiredVolume")) || state.volume;
      await player.setVolume(state.volume);
      notify("RenderingControl", { Volume: String(state.volume) });
      return xmlResp(soapResp("RenderingControl", action, {}));
    }
    case "GetMute":
      return xmlResp(soapResp("RenderingControl", action, { CurrentMute: state.mute ? "1" : "0" }));
    case "SetMute": {
      state.mute = getArg(body, "DesiredMute") === "1";
      await player.setMute(state.mute);
      notify("RenderingControl", { Mute: state.mute ? "1" : "0" });
      return xmlResp(soapResp("RenderingControl", action, {}));
    }
    case "ListPresets":
      return xmlResp(soapResp("RenderingControl", action, { CurrentPresetNameList: "FactoryDefaults" }));
    default:
      return soapFault("401", "Invalid Action");
  }
}

// ---------- ConnectionManager ----------

function handleConnMgr(action: string): Response {
  switch (action) {
    case "GetProtocolInfo":
      return xmlResp(soapResp("ConnectionManager", action, { Source: "", Sink: SINK_PROTOCOL_INFO }));
    case "GetCurrentConnectionIDs":
      return xmlResp(soapResp("ConnectionManager", action, { ConnectionIDs: "0" }));
    case "GetCurrentConnectionInfo":
      return xmlResp(soapResp("ConnectionManager", action, {
        RcsID: "0", AVTransportID: "0", ProtocolInfo: "",
        PeerConnectionManager: "", PeerConnectionID: "-1", Direction: "Input", Status: "OK",
      }));
    default:
      return soapFault("401", "Invalid Action");
  }
}

// ---------- HTTP server ----------

function serve(udn: string, ip: string): void {
  Bun.serve({
    // idleTimeout must comfortably exceed a cold-start SetAVTransportURI, which
    // blocks while spawning the Windows bridge + mpv (can take several seconds);
    // too low and Bun aborts the in-flight control connection mid-cast.
    port: HTTP_PORT, hostname: "0.0.0.0", idleTimeout: 30,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const method = req.method;

      if (path === "/device.xml") { console.log("[http] GET /device.xml"); return xmlResp(deviceXML(udn)); }
      if (path === "/scpd/AVTransport.xml") return xmlResp(AVTRANSPORT_SCPD);
      if (path === "/scpd/RenderingControl.xml") return xmlResp(RENDERINGCONTROL_SCPD);
      if (path === "/scpd/ConnectionManager.xml") return xmlResp(CONNECTIONMANAGER_SCPD);

      // GENA subscribe/unsubscribe
      if (method === "SUBSCRIBE") {
        const service = path.split("/").pop() || "";
        const callback = req.headers.get("CALLBACK")?.replace(/[<>]/g, "") || "";
        const sid = `uuid:${randomUUID()}`;
        console.log(`[gena] SUBSCRIBE ${service} callback=${callback || "(none)"}`);
        if (callback && (service === "AVTransport" || service === "RenderingControl")) {
          const list = subs.get(service) || [];
          list.push({ callback, sid, expires: Date.now() + 1800_000, seq: 0 });
          subs.set(service, list);
          // Send initial event
          if (service === "AVTransport") {
            fireEvent("AVTransport", { TransportState: state.transport, AVTransportURI: state.uri, AVTransportURIMetaData: state.metadata || "NOT_IMPLEMENTED" });
          } else {
            fireEvent("RenderingControl", { Volume: String(state.volume), Mute: state.mute ? "1" : "0" });
          }
        }
        return new Response(null, { status: 200, headers: { SID: sid, TIMEOUT: "Second-1800", "Content-Length": "0" } });
      }
      if (method === "UNSUBSCRIBE") {
        const sid = req.headers.get("SID") || "";
        for (const [svc, list] of subs) subs.set(svc, list.filter((s) => s.sid !== sid));
        return new Response(null, { status: 200 });
      }

      // SOAP control
      if (method === "POST" && path.startsWith("/control/")) {
        const action = (req.headers.get("SOAPACTION") || "").replace(/"/g, "").split("#")[1] || "";
        const body = await req.text();
        const t0 = Date.now();
        try {
          let resp: Response;
          if (path === "/control/AVTransport") resp = await handleAVTransport(action, body);
          else if (path === "/control/RenderingControl") resp = await handleRendering(action, body);
          else if (path === "/control/ConnectionManager") resp = handleConnMgr(action);
          else return soapFault("401", "Invalid Service");
          const ms = Date.now() - t0;
          if (ms > 500) console.warn(`[soap] ${action} SLOW ${ms}ms`);
          else console.log(`[soap] ${action} ${ms}ms`);
          return resp;
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

// ---------- Entry ----------

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
