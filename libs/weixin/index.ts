#!/usr/bin/env bun
/**
 * ax.ts weixin — 微信 Bot 收发消息。
 *
 * 基于 Tencent/openclaw-weixin 的 ilink/bot 协议重新实现，单账号、含媒体。
 * 网关默认: https://ilinkai.weixin.qq.com  CDN: https://novac2c.cdn.weixin.qq.com/c2c
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "1.0.0";
const ILINK_APP_CLIENT_VERSION = (1 << 16) | (0 << 8) | 0;
const BOT_AGENT = "ax-weixin/1.0.0";
const DEFAULT_BOT_TYPE = "3";

const STATE_DIR = path.join(os.homedir(), ".local", "state", "ax-weixin");
const ACCOUNT_FILE = path.join(STATE_DIR, "account.json");
const CONTEXT_TOKEN_FILE = path.join(STATE_DIR, "context-tokens.json");
const SYNC_BUF_FILE = path.join(STATE_DIR, "sync-buf.txt");

const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const UPDATES_LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const UPLOAD_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// 协议类型
// ---------------------------------------------------------------------------

const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;
const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}
interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; mid_size?: number };
  voice_item?: { media?: CDNMedia; playtime?: number; text?: string; encode_type?: number };
  file_item?: { media?: CDNMedia; file_name?: string; len?: string; md5?: string };
  video_item?: { media?: CDNMedia; video_size?: number; play_length?: number };
}
interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

// ---------------------------------------------------------------------------
// 状态存储
// ---------------------------------------------------------------------------

interface AccountData {
  token?: string;
  baseUrl?: string;
  userId?: string;
  savedAt?: string;
}

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadAccount(): AccountData {
  try {
    const raw = fs.readFileSync(ACCOUNT_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveAccount(data: Partial<AccountData>): void {
  ensureStateDir();
  const cur = loadAccount();
  const merged: AccountData = {
    ...cur,
    ...data,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(merged, null, 2), "utf-8");
  try { fs.chmodSync(ACCOUNT_FILE, 0o600); } catch {}
}

function clearAccount(): void {
  for (const f of [ACCOUNT_FILE, CONTEXT_TOKEN_FILE, SYNC_BUF_FILE]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

function loadContextTokens(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_TOKEN_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function setContextToken(userId: string, token: string): void {
  if (!userId || !token) return;
  ensureStateDir();
  const cur = loadContextTokens();
  cur[userId] = token;
  fs.writeFileSync(CONTEXT_TOKEN_FILE, JSON.stringify(cur), "utf-8");
}

function getContextToken(userId: string): string | undefined {
  return loadContextTokens()[userId];
}

function loadSyncBuf(): string {
  try { return fs.readFileSync(SYNC_BUF_FILE, "utf-8"); } catch { return ""; }
}

function saveSyncBuf(buf: string): void {
  ensureStateDir();
  fs.writeFileSync(SYNC_BUF_FILE, buf ?? "", "utf-8");
}

function requireToken(): { token: string; baseUrl: string } {
  const acct = loadAccount();
  if (!acct.token) {
    console.error("尚未登录。请先运行 `ax.ts weixin login`。");
    process.exit(1);
  }
  return { token: acct.token, baseUrl: acct.baseUrl || DEFAULT_BASE_URL };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
  const u = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(u), "utf-8").toString("base64");
}

function buildHeaders(token?: string, withAuth = true): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (withAuth) {
    h.AuthorizationType = "ilink_bot_token";
    h["X-WECHAT-UIN"] = randomWechatUin();
    if (token) h.Authorization = `Bearer ${token}`;
  }
  return h;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

async function apiPost(params: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  timeoutMs?: number;
}): Promise<any> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const ac = params.timeoutMs ? new AbortController() : undefined;
  const t = ac && params.timeoutMs ? setTimeout(() => ac.abort(), params.timeoutMs) : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(params.token, true),
      body: JSON.stringify(params.body),
      ...(ac ? { signal: ac.signal } : {}),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);
    try { return JSON.parse(txt); } catch { return txt; }
  } finally {
    if (t) clearTimeout(t);
  }
}

async function apiGetText(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const ac = params.timeoutMs ? new AbortController() : undefined;
  const t = ac && params.timeoutMs ? setTimeout(() => ac.abort(), params.timeoutMs) : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildHeaders(undefined, false),
      ...(ac ? { signal: ac.signal } : {}),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);
    return txt;
  } finally {
    if (t) clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

async function displayQR(qrUrl: string): Promise<void> {
  try {
    // @ts-ignore - no types shipped
    const mod: any = await import("qrcode-terminal");
    (mod.default ?? mod).generate(qrUrl, { small: true });
  } catch {}
  process.stdout.write(`若二维码无法扫描，可访问: ${qrUrl}\n`);
}

async function readStdinLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

async function fetchQRCode(existingTokens: string[]): Promise<{ qrcode: string; qrUrl: string }> {
  const qrResp = await apiPost({
    baseUrl: DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`,
    body: { local_token_list: existingTokens, base_info: baseInfo() },
    timeoutMs: API_TIMEOUT_MS,
  });
  const qrcode: string = qrResp.qrcode;
  const qrUrl: string = qrResp.qrcode_img_content;
  if (!qrcode || !qrUrl) throw new Error(`无法获取二维码: ${JSON.stringify(qrResp)}`);
  return { qrcode, qrUrl };
}

const MAX_QR_REFRESH = 3;

async function loginCmd(): Promise<void> {
  ensureStateDir();
  const acct = loadAccount();
  const existingTokens = acct.token ? [acct.token] : [];

  process.stdout.write("正在请求二维码...\n");
  let { qrcode, qrUrl } = await fetchQRCode(existingTokens);
  process.stdout.write("请用手机微信扫描以下二维码：\n\n");
  await displayQR(qrUrl);

  let currentBase = DEFAULT_BASE_URL;
  let pendingVerifyCode: string | undefined;
  let scannedPrinted = false;
  let qrRefreshCount = 1;
  const deadline = Date.now() + 8 * 60_000;

  while (Date.now() < deadline) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (pendingVerifyCode) endpoint += `&verify_code=${encodeURIComponent(pendingVerifyCode)}`;

    let statusResp: any;
    try {
      const txt = await apiGetText({
        baseUrl: currentBase,
        endpoint,
        timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      });
      statusResp = JSON.parse(txt);
    } catch (err: any) {
      if (err.name === "AbortError") { statusResp = { status: "wait" }; }
      else { process.stdout.write(`\n网络错误: ${err.message ?? String(err)}\n`); statusResp = { status: "wait" }; }
    }

    switch (statusResp.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (pendingVerifyCode) pendingVerifyCode = undefined;
        if (!scannedPrinted) { process.stdout.write("\n已扫描，正在验证...\n"); scannedPrinted = true; }
        break;
      case "need_verifycode": {
        const prompt = pendingVerifyCode ? "❌ 数字错误，请重新输入：" : "请输入手机微信显示的数字：";
        pendingVerifyCode = await readStdinLine(prompt);
        continue;
      }
      case "scaned_but_redirect": {
        if (statusResp.redirect_host) currentBase = `https://${statusResp.redirect_host}`;
        break;
      }
      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH) {
          console.error("\n二维码多次失效，停止登录。");
          process.exit(1);
        }
        process.stdout.write(`\n⏳ 二维码已过期，刷新中 (${qrRefreshCount}/${MAX_QR_REFRESH})...\n`);
        currentBase = DEFAULT_BASE_URL;
        ({ qrcode, qrUrl } = await fetchQRCode(existingTokens));
        scannedPrinted = false;
        await displayQR(qrUrl);
        continue;
      }
      case "verify_code_blocked": {
        pendingVerifyCode = undefined;
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH) {
          console.error("\n多次输入错误，停止登录。");
          process.exit(1);
        }
        process.stdout.write(`\n⛔ 多次输入错误，刷新二维码 (${qrRefreshCount}/${MAX_QR_REFRESH})...\n`);
        currentBase = DEFAULT_BASE_URL;
        ({ qrcode, qrUrl } = await fetchQRCode(existingTokens));
        scannedPrinted = false;
        await displayQR(qrUrl);
        continue;
      }
      case "binded_redirect":
        process.stdout.write("\n已绑定过，无需重复登录。\n");
        return;
      case "confirmed": {
        const token = statusResp.bot_token;
        const baseUrl = statusResp.baseurl || DEFAULT_BASE_URL;
        const userId = statusResp.ilink_user_id;
        if (!token) {
          console.error("\n登录失败：服务端未返回 bot_token。");
          process.exit(1);
        }
        saveAccount({ token, baseUrl, userId });
        process.stdout.write(`\n✅ 登录成功。bot_id=${statusResp.ilink_bot_id} user=${userId ?? "?"}\n`);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("\n登录超时。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// updates
// ---------------------------------------------------------------------------

function formatItem(item: MessageItem): string {
  switch (item.type) {
    case MessageItemType.TEXT: return item.text_item?.text ?? "";
    case MessageItemType.IMAGE: return "[图片]";
    case MessageItemType.VOICE: {
      const t = item.voice_item?.text;
      return t ? `[语音: ${t}]` : "[语音]";
    }
    case MessageItemType.FILE: return `[文件: ${item.file_item?.file_name ?? "?"}]`;
    case MessageItemType.VIDEO: return "[视频]";
    default: return `[未知类型 ${item.type}]`;
  }
}

function formatMessage(m: WeixinMessage): string {
  const date = m.create_time_ms
    ? new Date(m.create_time_ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "?";
  const dir = m.message_type === MessageType.BOT ? "→" : "←";
  const peer = m.from_user_id || m.to_user_id || "?";
  const body = (m.item_list ?? []).map(formatItem).join(" ");
  return `[${date}] ${dir} ${peer}: ${body}`;
}

async function updatesCmd(rest: string[]): Promise<void> {
  const wait = rest.includes("--wait");
  const json = rest.includes("--json");
  const reset = rest.includes("--reset");
  const { token, baseUrl } = requireToken();

  if (reset) saveSyncBuf("");

  while (true) {
    const buf = loadSyncBuf();
    let resp: any;
    try {
      resp = await apiPost({
        baseUrl,
        token,
        endpoint: "ilink/bot/getupdates",
        body: { get_updates_buf: buf, base_info: baseInfo() },
        timeoutMs: UPDATES_LONG_POLL_TIMEOUT_MS,
      });
    } catch (err: any) {
      if (err.name === "AbortError") {
        if (!wait) { console.log(json ? "[]" : "没有新消息。"); return; }
        continue;
      }
      throw err;
    }

    if (resp.errcode && resp.errcode !== 0) {
      console.error(`getUpdates 错误 errcode=${resp.errcode} ${resp.errmsg ?? ""}`);
      if (resp.errcode === -14) {
        console.error("会话失效，请重新登录。");
        process.exit(1);
      }
      process.exit(1);
    }

    if (typeof resp.get_updates_buf === "string") saveSyncBuf(resp.get_updates_buf);

    const msgs: WeixinMessage[] = resp.msgs ?? [];
    for (const m of msgs) {
      if (m.context_token && m.from_user_id) {
        setContextToken(m.from_user_id, m.context_token);
      }
    }

    if (msgs.length) {
      if (json) for (const m of msgs) console.log(JSON.stringify(m));
      else for (const m of msgs) console.log(formatMessage(m));
      return;
    }
    if (!wait) { console.log(json ? "[]" : "没有新消息。"); return; }
  }
}

// ---------------------------------------------------------------------------
// send 文本
// ---------------------------------------------------------------------------

function generateClientId(): string {
  return `ax-weixin-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendRaw(params: {
  baseUrl: string;
  token: string;
  to: string;
  contextToken?: string;
  item: MessageItem;
}): Promise<string> {
  const clientId = generateClientId();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [params.item],
      context_token: params.contextToken,
    },
    base_info: baseInfo(),
  };
  await apiPost({
    baseUrl: params.baseUrl,
    token: params.token,
    endpoint: "ilink/bot/sendmessage",
    body,
    timeoutMs: API_TIMEOUT_MS,
  });
  return clientId;
}

async function sendTextCmd(to: string, text: string, jsonOut: boolean): Promise<void> {
  const { token, baseUrl } = requireToken();
  const ctx = getContextToken(to);
  if (!ctx) {
    console.error(`警告: 找不到 ${to} 的 context_token，建议先收一条来信。继续发送但可能被拒。`);
  }
  const id = await sendRaw({
    baseUrl, token, to, contextToken: ctx,
    item: { type: MessageItemType.TEXT, text_item: { text } },
  });
  console.log(jsonOut ? JSON.stringify({ client_id: id, to }) : `sent to ${to} (client_id: ${id})`);
}

// ---------------------------------------------------------------------------
// 媒体上传
// ---------------------------------------------------------------------------

function aesEcbPaddedSize(n: number): number {
  return Math.ceil((n + 1) / 16) * 16;
}

function encryptAesEcb(plain: Buffer, key: Buffer): Buffer {
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

function decryptAesEcb(cipher: Buffer, key: Buffer): Buffer {
  const d = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([d.update(cipher), d.final()]);
}

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function buildCdnDownloadUrl(encryptedQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

interface UploadedInfo {
  filekey: string;
  downloadParam: string;
  aeskeyHex: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

async function uploadMedia(opts: {
  baseUrl: string;
  token: string;
  filePath: string;
  toUserId: string;
  mediaType: number;
}): Promise<UploadedInfo> {
  const plaintext = await fs.promises.readFile(opts.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadResp = await apiPost({
    baseUrl: opts.baseUrl,
    token: opts.token,
    endpoint: "ilink/bot/getuploadurl",
    body: {
      filekey,
      media_type: opts.mediaType,
      to_user_id: opts.toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: baseInfo(),
    },
    timeoutMs: API_TIMEOUT_MS,
  });

  const uploadFullUrl: string | undefined = uploadResp.upload_full_url?.trim();
  const uploadParam: string | undefined = uploadResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`getUploadUrl 未返回上传 URL: ${JSON.stringify(uploadResp)}`);
  }
  const cdnUrl = uploadFullUrl || buildCdnUploadUrl(uploadParam!, filekey);
  const ciphertext = encryptAesEcb(plaintext, aeskey);

  let downloadParam: string | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const msg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN 4xx ${res.status}: ${msg}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN ${res.status}: ${res.headers.get("x-error-message") ?? ""}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) throw new Error("CDN 未返回 x-encrypted-param");
      break;
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.message.includes("CDN 4xx")) throw e;
      if (attempt < UPLOAD_MAX_RETRIES) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!downloadParam) throw (lastErr instanceof Error ? lastErr : new Error("CDN 上传失败"));

  return {
    filekey,
    downloadParam,
    aeskeyHex: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

// ---------------------------------------------------------------------------
// MIME 推断
// ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
};

function mimeFromPath(p: string): string {
  return EXT_MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// send 媒体
// ---------------------------------------------------------------------------

async function sendMediaCmd(args: {
  to: string;
  filePath: string;
  caption: string;
  jsonOut: boolean;
}): Promise<void> {
  const { token, baseUrl } = requireToken();
  const ctx = getContextToken(args.to);
  if (!ctx) console.error(`警告: ${args.to} 无 context_token`);

  const mime = mimeFromPath(args.filePath);
  let mediaType: number;
  if (mime.startsWith("video/")) mediaType = UploadMediaType.VIDEO;
  else if (mime.startsWith("image/")) mediaType = UploadMediaType.IMAGE;
  else mediaType = UploadMediaType.FILE;

  process.stderr.write(`上传中 (${mime})...\n`);
  const up = await uploadMedia({
    baseUrl, token, filePath: args.filePath, toUserId: args.to, mediaType,
  });

  const aesKeyBase64 = Buffer.from(up.aeskeyHex, "utf-8").toString("base64");
  const media: CDNMedia = {
    encrypt_query_param: up.downloadParam,
    aes_key: aesKeyBase64,
    encrypt_type: 1,
  };

  let item: MessageItem;
  if (mediaType === UploadMediaType.IMAGE) {
    item = { type: MessageItemType.IMAGE, image_item: { media, mid_size: up.fileSizeCiphertext } };
  } else if (mediaType === UploadMediaType.VIDEO) {
    item = { type: MessageItemType.VIDEO, video_item: { media, video_size: up.fileSizeCiphertext } };
  } else {
    const fileName = path.basename(args.filePath);
    item = {
      type: MessageItemType.FILE,
      file_item: { media, file_name: fileName, len: String(up.fileSize) },
    };
  }

  let captionId: string | undefined;
  if (args.caption) {
    captionId = await sendRaw({
      baseUrl, token, to: args.to, contextToken: ctx,
      item: { type: MessageItemType.TEXT, text_item: { text: args.caption } },
    });
  }
  const mediaId = await sendRaw({
    baseUrl, token, to: args.to, contextToken: ctx, item,
  });

  if (args.jsonOut) {
    console.log(JSON.stringify({ to: args.to, caption_client_id: captionId, media_client_id: mediaId, filekey: up.filekey }));
  } else {
    console.log(`sent media to ${args.to} (client_id: ${mediaId}, filekey: ${up.filekey})`);
  }
}

// ---------------------------------------------------------------------------
// typing
// ---------------------------------------------------------------------------

async function typingCmd(to: string, cancel: boolean): Promise<void> {
  const { token, baseUrl } = requireToken();
  const ctx = getContextToken(to);

  const cfg = await apiPost({
    baseUrl, token,
    endpoint: "ilink/bot/getconfig",
    body: { ilink_user_id: to, context_token: ctx, base_info: baseInfo() },
    timeoutMs: API_TIMEOUT_MS,
  });
  const ticket = cfg.typing_ticket;
  if (!ticket) { console.error("未获取到 typing_ticket"); process.exit(1); }

  await apiPost({
    baseUrl, token,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: to,
      typing_ticket: ticket,
      status: cancel ? TypingStatus.CANCEL : TypingStatus.TYPING,
      base_info: baseInfo(),
    },
    timeoutMs: API_TIMEOUT_MS,
  });
  console.log(`typing ${cancel ? "cancel" : "start"} -> ${to}`);
}

// ---------------------------------------------------------------------------
// download 媒体
// ---------------------------------------------------------------------------

function parseAesKeyField(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`aes_key 不是 16 字节也不是 32 字符 hex: got ${decoded.length} bytes`);
}

async function downloadCmd(args: {
  encryptedParam?: string;
  aesKey?: string;
  fullUrl?: string;
  output: string;
  plain: boolean;
}): Promise<void> {
  const url = args.fullUrl || (args.encryptedParam ? buildCdnDownloadUrl(args.encryptedParam) : undefined);
  if (!url) { console.error("需要 --full-url 或 --param"); process.exit(1); }
  const res = await fetch(url);
  if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  let buf: Buffer = Buffer.from(await res.arrayBuffer());
  if (!args.plain) {
    if (!args.aesKey) { console.error("解密需要 --aes-key（CDNMedia.aes_key 的 base64）"); process.exit(1); }
    buf = decryptAesEcb(buf, parseAesKeyField(args.aesKey));
  }
  await fs.promises.writeFile(args.output, buf);
  console.log(`saved ${buf.length} bytes -> ${args.output}`);
}

// ---------------------------------------------------------------------------
// status / logout
// ---------------------------------------------------------------------------

function statusCmd(jsonOut: boolean): void {
  const acct = loadAccount();
  const ctx = loadContextTokens();
  const out = {
    logged_in: Boolean(acct.token),
    user_id: acct.userId,
    base_url: acct.baseUrl || DEFAULT_BASE_URL,
    saved_at: acct.savedAt,
    known_users: Object.keys(ctx),
  };
  if (jsonOut) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`logged_in: ${out.logged_in}`);
    console.log(`user_id  : ${out.user_id ?? "-"}`);
    console.log(`base_url : ${out.base_url}`);
    console.log(`saved_at : ${out.saved_at ?? "-"}`);
    console.log(`known_users (${out.known_users.length}): ${out.known_users.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: ax.ts weixin <subcommand> [args...]

  login                              扫码登录（凭据存到 ~/.local/state/ax-weixin/）
  logout                             清除本地凭据 / context_token / sync_buf
  status [--json]                    显示登录状态与已知联系人
  updates [--wait] [--reset] [--json]
                                     拉取新消息（自动保存 context_token、sync_buf）
                                     --wait 长轮询直到 Ctrl+C；--reset 清空 sync_buf
  send <to_user_id> <text> [--json]  发送文本消息
  send <to_user_id> -f <file> [-t <caption>] [--json]
                                     上传并发送图片/视频/文件（按 MIME 自动分类）
  typing <to_user_id> [--cancel]     发送/取消正在输入指示器
  download (--param <p> | --full-url <u>) [--aes-key <k>] [--plain] -o <out>
                                     从 CDN 下载并解密（不传 --aes-key 需配合 --plain）
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    process.exit(args.length === 0 ? 1 : 0);
  }
  const [sub, ...rest] = args;

  switch (sub) {
    case "login": await loginCmd(); break;
    case "logout":
      clearAccount();
      console.log("已清除本地凭据。");
      break;
    case "status":
      statusCmd(rest.includes("--json"));
      break;
    case "updates":
      await updatesCmd(rest);
      break;
    case "send": {
      const jsonOut = rest.includes("--json");
      let to: string | undefined;
      let file: string | undefined;
      let caption = "";
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--json") continue;
        if (a === "-f") { file = rest[++i]; continue; }
        if (a === "-t") { caption = rest[++i] ?? ""; continue; }
        positional.push(a);
      }
      to = positional[0];
      if (!to) { console.error("用法: send <to_user_id> (<text> | -f <file> [-t <caption>])"); process.exit(1); }
      if (file) {
        await sendMediaCmd({ to, filePath: file, caption, jsonOut });
      } else {
        if (positional.length < 2) { console.error("用法: send <to_user_id> <text>"); process.exit(1); }
        const text = positional.slice(1).join(" ");
        await sendTextCmd(to, text, jsonOut);
      }
      break;
    }
    case "typing": {
      const to = rest.find((a) => !a.startsWith("--"));
      if (!to) { console.error("用法: typing <to_user_id> [--cancel]"); process.exit(1); }
      await typingCmd(to, rest.includes("--cancel"));
      break;
    }
    case "download": {
      const get = (k: string) => {
        const i = rest.indexOf(k);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      await downloadCmd({
        encryptedParam: get("--param"),
        aesKey: get("--aes-key"),
        fullUrl: get("--full-url"),
        output: get("-o") ?? "",
        plain: rest.includes("--plain"),
      });
      break;
    }
    default:
      console.error(`未知子命令: ${sub}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`错误: ${err?.stack || err?.message || String(err)}`);
  process.exit(1);
});
