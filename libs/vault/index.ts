#!/usr/bin/env bun
// Vault: SSH-backed JSON store on the router. Single file /etc/vault.json
// holds an array of {key, value, type}. Every operation does an atomic
// load-modify-save via SSH — fine for low-volume admin use.

const SSH_HOST = "root@10.0.0.1";
const REMOTE_FILE = "/etc/vault.json";

export type VaultType = "totp" | "simple";
export interface Entry { key: string; value: string; type: VaultType }

// ── SSH transport ─────────────────────────────────────────────────────────────

async function ssh(cmd: string, stdin?: string): Promise<string> {
  const p = Bun.spawn(["ssh", SSH_HOST, cmd], {
    stdin: stdin !== undefined ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) { p.stdin.write(stdin); p.stdin.end(); }
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`ssh failed (${code}): ${err.trim() || out.trim()}`);
  return out;
}

async function loadAll(): Promise<Entry[]> {
  const raw = (await ssh(`cat ${REMOTE_FILE} 2>/dev/null || echo '[]'`)).trim();
  if (!raw) return [];
  const j = JSON.parse(raw);
  if (!Array.isArray(j)) throw new Error("vault file is not a JSON array");
  return j;
}

async function saveAll(entries: Entry[]): Promise<void> {
  entries.sort((a, b) => a.key.localeCompare(b.key));
  const json = JSON.stringify(entries, null, 2);
  // Atomic replace; preserve restrictive perms.
  await ssh(`cat > ${REMOTE_FILE}.tmp && chmod 600 ${REMOTE_FILE}.tmp && mv ${REMOTE_FILE}.tmp ${REMOTE_FILE}`, json);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getEntry(key: string): Promise<Entry> {
  const e = (await loadAll()).find(x => x.key === key);
  if (!e) throw new Error(`no such key: ${key}`);
  return e;
}

export async function get(key: string): Promise<string> {
  return (await getEntry(key)).value;
}

export async function put(key: string, value: string, type: VaultType = "simple"): Promise<void> {
  const entries = await loadAll();
  const idx = entries.findIndex(x => x.key === key);
  if (idx >= 0) entries[idx] = { key, value, type };
  else entries.push({ key, value, type });
  await saveAll(entries);
}

export async function list(): Promise<Entry[]> {
  return loadAll();
}

export async function del(key: string): Promise<void> {
  const entries = await loadAll();
  const filtered = entries.filter(x => x.key !== key);
  if (filtered.length === entries.length) throw new Error(`no such key: ${key}`);
  await saveAll(filtered);
}

// ── TOTP (RFC 6238, SHA-1, 30s, 6 digits) ─────────────────────────────────────

function base32Decode(s: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

export async function totp(secret: string, at: number = Date.now()): Promise<string> {
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / 30);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter));
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24 | sig[offset + 1] << 16 | sig[offset + 2] << 8 | sig[offset + 3]) % 1_000_000;
  return code.toString().padStart(6, "0");
}

// ── Hidden TTY input (sudo-style) ─────────────────────────────────────────────

async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) { chunks.push(c as Buffer); }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let buf = "";
  try {
    for await (const chunk of stdin) {
      for (const byte of chunk as Buffer) {
        if (byte === 0x03) { process.stderr.write("\n"); throw new Error("aborted"); }
        if (byte === 0x04 && buf === "") { process.stderr.write("\n"); throw new Error("aborted"); }
        if (byte === 0x0d || byte === 0x0a) { process.stderr.write("\n"); return buf; }
        if (byte === 0x7f || byte === 0x08) { buf = buf.slice(0, -1); continue; }
        if (byte < 0x20) continue;
        buf += String.fromCharCode(byte);
      }
    }
    return buf;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";

function scanDeclaredKeys(): { lib: string; key: string }[] {
  const libsDir = resolve(import.meta.dir, "..");
  const entries = readdirSync(libsDir, { withFileTypes: true });
  const result: { lib: string; key: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "vault") continue;
    const pkgPath = resolve(libsDir, entry.name, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (Array.isArray(pkg.vault)) {
        for (const key of pkg.vault) result.push({ lib: entry.name, key });
      }
    } catch {}
  }
  return result;
}

async function cmdSetup() {
  const required = scanDeclaredKeys();

  if (required.length === 0) {
    console.log("没有子命令声明 vault key");
    return;
  }

  const existing = await loadAll();
  const existingKeys = new Set(existing.map(e => e.key));

  console.log(`扫描到 ${required.length} 个 vault key：\n`);

  let missing = 0;
  let skipped = 0;
  for (const { lib, key } of required) {
    if (existingKeys.has(key)) {
      console.log(`  🔑 ${key} (${lib}) — 已存在`);
      skipped++;
    } else {
      console.log(`  🔑 ${key} (${lib}) — 缺失`);
      missing++;
    }
  }

  if (missing === 0) {
    console.log(`\n全部 ${skipped} 个 key 已配置`);
    return;
  }

  console.log(`\n需要配置 ${missing} 个 key，跳过 ${skipped} 个已存在的\n`);

  for (const { lib, key } of required) {
    if (existingKeys.has(key)) continue;

    console.log(`[${lib}] 配置 ${key}`);
    const isTotp = key.includes("totp") || key.includes("mfa");

    const value = await readSecret(`  值: `);
    if (!value) {
      console.log(`  跳过\n`);
      continue;
    }

    if (isTotp) {
      try { base32Decode(value); } catch {
        console.error(`  ⚠ 无效的 base32，跳过\n`);
        continue;
      }
      await put(key, value.replace(/\s+/g, "").toUpperCase(), "totp");
    } else {
      await put(key, value, "simple");
    }
    console.log(`  ✓ 已保存\n`);
  }

  console.log("配置完成");
}

async function cmdExport() {
  const entries = await loadAll();
  console.log(JSON.stringify(entries, null, 2));
}

async function cmdImport() {
  const stdin = (await new Response(process.stdin).text()).trim();
  if (!stdin) throw new Error("stdin 为空，请通过管道传入 JSON");

  let data: any[];
  try {
    data = JSON.parse(stdin);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${(e as Error).message}`);
  }

  if (!Array.isArray(data)) throw new Error("JSON 必须是数组");

  const existing = await loadAll();
  const existingMap = new Map(existing.map(e => [e.key, e]));
  let added = 0;
  let updated = 0;

  for (const item of data) {
    if (!item.key || !item.value) continue;
    const type: VaultType = item.type === "totp" ? "totp" : "simple";
    if (existingMap.has(item.key)) {
      updated++;
    } else {
      added++;
    }
    await put(item.key, item.value, type);
  }

  console.log(`导入完成: ${added} 新增, ${updated} 更新`);
}

async function cmdAutoremove() {
  const declared = scanDeclaredKeys();
  const declaredKeys = new Set(declared.map(d => d.key));
  const existing = await loadAll();

  const toRemove = existing.filter(e => !declaredKeys.has(e.key));

  if (toRemove.length === 0) {
    console.log("没有需要清理的 key");
    return;
  }

  console.log(`将删除 ${toRemove.length} 个未声明的 key:\n`);
  for (const e of toRemove) {
    console.log(`  ${e.type === "totp" ? "🔢" : "🔑"} ${e.key}`);
    await del(e.key);
  }
  console.log(`\n已删除 ${toRemove.length} 个 key`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const totpFlag = args.includes("--totp");
  const positional = args.filter(a => a !== "--totp");
  const [cmd, key] = positional;

  const usage = (): never => {
    console.error("Usage: vault get|delete <key>");
    console.error("       vault put <key> [--totp]");
    console.error("       vault list");
    console.error("       vault setup");
    console.error("       vault export");
    console.error("       vault import     (reads JSON from stdin)");
    console.error("       vault autoremove");
    process.exit(1);
  };

  try {
    switch (cmd) {
      case "get": {
        if (!key) usage();
        const e = await getEntry(key);
        console.log(e.type === "totp" ? await totp(e.value) : e.value);
        break;
      }
      case "put": {
        if (!key) usage();
        const v = await readSecret(`vault: value for ${key}: `);
        if (!v) throw new Error("empty value");
        if (totpFlag) {
          try { base32Decode(v); } catch (e) { throw new Error(`invalid base32 secret: ${(e as Error).message}`); }
          await put(key, v.replace(/\s+/g, "").toUpperCase(), "totp");
        } else {
          await put(key, v, "simple");
        }
        break;
      }
      case "delete": {
        if (!key) usage();
        await del(key);
        console.log("deleted");
        break;
      }
      case "list": {
        const icon: Record<VaultType, string> = { simple: "🔑", totp: "🔢" };
        for (const e of await list()) console.log(`${icon[e.type]} ${e.key}`);
        break;
      }
      case "setup": {
        await cmdSetup();
        break;
      }
      case "export": {
        await cmdExport();
        break;
      }
      case "import": {
        await cmdImport();
        break;
      }
      case "autoremove": {
        await cmdAutoremove();
        break;
      }
      default: usage();
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
