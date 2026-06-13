// UPnP 描述文档：设备描述 + 三个服务的 SCPD
import { FRIENDLY_NAME, MANUFACTURER, MODEL_NAME } from "./config";

export function deviceXML(udn: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>${esc(FRIENDLY_NAME)}</friendlyName>
    <manufacturer>${MANUFACTURER}</manufacturer>
    <manufacturerURL>https://github.com</manufacturerURL>
    <modelName>${MODEL_NAME}</modelName>
    <modelNumber>1.0</modelNumber>
    <modelDescription>DLNA renderer bridging to Windows mpv</modelDescription>
    <UDN>${udn}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <SCPDURL>/scpd/AVTransport.xml</SCPDURL>
        <controlURL>/control/AVTransport</controlURL>
        <eventSubURL>/event/AVTransport</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <SCPDURL>/scpd/RenderingControl.xml</SCPDURL>
        <controlURL>/control/RenderingControl</controlURL>
        <eventSubURL>/event/RenderingControl</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/scpd/ConnectionManager.xml</SCPDURL>
        <controlURL>/control/ConnectionManager</controlURL>
        <eventSubURL>/event/ConnectionManager</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

function action(name: string, args: [string, "in" | "out", string][]): string {
  const a = args
    .map(
      ([n, dir, rel]) =>
        `<argument><name>${n}</name><direction>${dir}</direction><relatedStateVariable>${rel}</relatedStateVariable></argument>`,
    )
    .join("");
  return `<action><name>${name}</name><argumentList>${a}</argumentList></action>`;
}

function sv(name: string, type: string, opts: { events?: boolean; allowed?: string[] } = {}): string {
  const allowed = opts.allowed
    ? `<allowedValueList>${opts.allowed.map((v) => `<allowedValue>${v}</allowedValue>`).join("")}</allowedValueList>`
    : "";
  return `<stateVariable sendEvents="${opts.events ? "yes" : "no"}"><name>${name}</name><dataType>${type}</dataType>${allowed}</stateVariable>`;
}

function scpd(actions: string, vars: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>${actions}</actionList>
  <serviceStateTable>${vars}</serviceStateTable>
</scpd>`;
}

export const AVTRANSPORT_SCPD = scpd(
  [
    action("SetAVTransportURI", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["CurrentURI", "in", "AVTransportURI"],
      ["CurrentURIMetaData", "in", "AVTransportURIMetaData"],
    ]),
    action("GetMediaInfo", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["NrTracks", "out", "NumberOfTracks"],
      ["MediaDuration", "out", "CurrentMediaDuration"],
      ["CurrentURI", "out", "AVTransportURI"],
      ["CurrentURIMetaData", "out", "AVTransportURIMetaData"],
      ["NextURI", "out", "NextAVTransportURI"],
      ["NextURIMetaData", "out", "NextAVTransportURIMetaData"],
      ["PlayMedium", "out", "PlaybackStorageMedium"],
      ["RecordMedium", "out", "RecordStorageMedium"],
      ["WriteStatus", "out", "RecordMediumWriteStatus"],
    ]),
    action("GetTransportInfo", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["CurrentTransportState", "out", "TransportState"],
      ["CurrentTransportStatus", "out", "TransportStatus"],
      ["CurrentSpeed", "out", "TransportPlaySpeed"],
    ]),
    action("GetPositionInfo", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["Track", "out", "CurrentTrack"],
      ["TrackDuration", "out", "CurrentTrackDuration"],
      ["TrackMetaData", "out", "CurrentTrackMetaData"],
      ["TrackURI", "out", "CurrentTrackURI"],
      ["RelTime", "out", "RelativeTimePosition"],
      ["AbsTime", "out", "AbsoluteTimePosition"],
      ["RelCount", "out", "RelativeCounterPosition"],
      ["AbsCount", "out", "AbsoluteCounterPosition"],
    ]),
    action("Stop", [["InstanceID", "in", "A_ARG_TYPE_InstanceID"]]),
    action("Play", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["Speed", "in", "TransportPlaySpeed"],
    ]),
    action("Pause", [["InstanceID", "in", "A_ARG_TYPE_InstanceID"]]),
    action("Seek", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["Unit", "in", "A_ARG_TYPE_SeekMode"],
      ["Target", "in", "A_ARG_TYPE_SeekTarget"],
    ]),
    action("Next", [["InstanceID", "in", "A_ARG_TYPE_InstanceID"]]),
    action("Previous", [["InstanceID", "in", "A_ARG_TYPE_InstanceID"]]),
  ].join(""),
  [
    sv("TransportState", "string", { events: true, allowed: ["STOPPED", "PLAYING", "PAUSED_PLAYBACK", "TRANSITIONING", "NO_MEDIA_PRESENT"] }),
    sv("TransportStatus", "string", { allowed: ["OK", "ERROR_OCCURRED"] }),
    sv("TransportPlaySpeed", "string"),
    sv("AVTransportURI", "string"),
    sv("AVTransportURIMetaData", "string"),
    sv("NextAVTransportURI", "string"),
    sv("NextAVTransportURIMetaData", "string"),
    sv("CurrentTrackDuration", "string"),
    sv("CurrentMediaDuration", "string"),
    sv("CurrentTrackMetaData", "string"),
    sv("CurrentTrackURI", "string"),
    sv("RelativeTimePosition", "string"),
    sv("AbsoluteTimePosition", "string"),
    sv("RelativeCounterPosition", "i4"),
    sv("AbsoluteCounterPosition", "i4"),
    sv("CurrentTrack", "ui4"),
    sv("NumberOfTracks", "ui4"),
    sv("PlaybackStorageMedium", "string"),
    sv("RecordStorageMedium", "string"),
    sv("RecordMediumWriteStatus", "string"),
    sv("A_ARG_TYPE_SeekMode", "string", { allowed: ["REL_TIME", "ABS_TIME", "TRACK_NR"] }),
    sv("A_ARG_TYPE_SeekTarget", "string"),
    sv("A_ARG_TYPE_InstanceID", "ui4"),
    sv("LastChange", "string", { events: true }),
  ].join(""),
);

export const RENDERINGCONTROL_SCPD = scpd(
  [
    action("GetVolume", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["Channel", "in", "A_ARG_TYPE_Channel"],
      ["CurrentVolume", "out", "Volume"],
    ]),
    action("SetVolume", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["Channel", "in", "A_ARG_TYPE_Channel"],
      ["DesiredVolume", "in", "Volume"],
    ]),
    action("GetMute", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["Channel", "in", "A_ARG_TYPE_Channel"],
      ["CurrentMute", "out", "Mute"],
    ]),
    action("SetMute", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["Channel", "in", "A_ARG_TYPE_Channel"],
      ["DesiredMute", "in", "Mute"],
    ]),
    action("ListPresets", [
      ["InstanceID", "in", "A_ARG_TYPE_InstanceID"],
      ["CurrentPresetNameList", "out", "PresetNameList"],
    ]),
  ].join(""),
  [
    sv("Volume", "ui2"),
    sv("Mute", "boolean"),
    sv("PresetNameList", "string"),
    sv("A_ARG_TYPE_Channel", "string", { allowed: ["Master"] }),
    sv("A_ARG_TYPE_InstanceID", "ui4"),
    sv("LastChange", "string", { events: true }),
  ].join(""),
);

export const CONNECTIONMANAGER_SCPD = scpd(
  [
    action("GetProtocolInfo", [
      ["Source", "out", "SourceProtocolInfo"],
      ["Sink", "out", "SinkProtocolInfo"],
    ]),
    action("GetCurrentConnectionIDs", [["ConnectionIDs", "out", "CurrentConnectionIDs"]]),
    action("GetCurrentConnectionInfo", [
      ["ConnectionID", "in", "A_ARG_TYPE_ConnectionID"],
      ["RcsID", "out", "A_ARG_TYPE_RcsID"],
      ["AVTransportID", "out", "A_ARG_TYPE_AVTransportID"],
      ["ProtocolInfo", "out", "A_ARG_TYPE_ProtocolInfo"],
      ["PeerConnectionManager", "out", "A_ARG_TYPE_ConnectionManager"],
      ["PeerConnectionID", "out", "A_ARG_TYPE_ConnectionID"],
      ["Direction", "out", "A_ARG_TYPE_Direction"],
      ["Status", "out", "A_ARG_TYPE_ConnectionStatus"],
    ]),
  ].join(""),
  [
    sv("SourceProtocolInfo", "string", { events: true }),
    sv("SinkProtocolInfo", "string", { events: true }),
    sv("CurrentConnectionIDs", "string", { events: true }),
    sv("A_ARG_TYPE_ConnectionStatus", "string"),
    sv("A_ARG_TYPE_ConnectionManager", "string"),
    sv("A_ARG_TYPE_Direction", "string"),
    sv("A_ARG_TYPE_ProtocolInfo", "string"),
    sv("A_ARG_TYPE_ConnectionID", "i4"),
    sv("A_ARG_TYPE_AVTransportID", "i4"),
    sv("A_ARG_TYPE_RcsID", "i4"),
  ].join(""),
);

// 我们能接收(Sink)的格式：用通配，尽量让各种控制点都肯推流
export const SINK_PROTOCOL_INFO = [
  "http-get:*:video/*:*",
  "http-get:*:audio/*:*",
  "http-get:*:image/*:*",
  "http-get:*:application/octet-stream:*",
].join(",");

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
