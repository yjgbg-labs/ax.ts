#!/usr/bin/env bun

import { mkdir } from "fs/promises";
import { homedir } from "os";
import { resolve } from "path";

const VAULT_KEY = "mimo_token_plan_token";
const API_BASE = "https://api.xiaomimimo.com/v1";
const TP_BASE_CN = "https://token-plan-cn.xiaomimimo.com/v1";
const TP_BASE_SGP = "https://token-plan-sgp.xiaomimimo.com/v1";
const DEFAULT_OUT_DIR = resolve(homedir(), "Music/ax-tts");
const DEFAULT_MODEL = "mimo-v2.5-tts-voicedesign";
const DEFAULT_VOICE = "mimo_default";
const DEFAULT_FORMAT = "wav";

// Default voice design prompt (used when no -s given with voicedesign model)
const DEFAULT_VOICE_DESIGN = "一位年轻女性，声音清晰自然，标准普通话，语速很快";

// ─── V2.5 preset voices ─────────────────────────────────────────────
const V25_VOICES: Record<string, { name: string; lang: string; gender: string }> = {
  mimo_default: { name: "MiMo-默认", lang: "自动", gender: "自动" },
  "冰糖":        { name: "冰糖",      lang: "中文", gender: "女" },
  "茉莉":        { name: "茉莉",      lang: "中文", gender: "女" },
  "苏打":        { name: "苏打",      lang: "中文", gender: "男" },
  "白桦":        { name: "白桦",      lang: "中文", gender: "男" },
  Mia:          { name: "Mia",       lang: "英文", gender: "女" },
  Chloe:        { name: "Chloe",     lang: "英文", gender: "女" },
  Milo:         { name: "Milo",      lang: "英文", gender: "男" },
  Dean:         { name: "Dean",      lang: "英文", gender: "男" },
};

// ─── V2 (legacy) voices ─────────────────────────────────────────────
const V2_VOICES: Record<string, string> = {
  mimo_default: "MiMo-默认",
  default_zh:   "MiMo-中文女声",
  default_en:   "MiMo-English Female",
};

const HELP = `Usage: ax.ts tts [options] [text]

  调用小米 MiMo TTS 将文本转为语音，默认下载到 ~/Music/ax-tts/。
  默认使用 VoiceDesign 模型（mimo-v2.5-tts-voicedesign），无需预置音色。

Options:
  -s, --style <text>     音色描述 / 风格指令（默认："${DEFAULT_VOICE_DESIGN}"）
  -v, --voice <name>     标准 TTS 音色（仅 -m mimo-v2.5-tts 时生效）
  -m, --model <name>     模型（默认 ${DEFAULT_MODEL}）
  -o, --out <path>       输出路径；- 表示不保存，仅打印 base64
  --format <fmt>         音频格式 wav | pcm16（默认 wav）
  -f, --file <path>      从文件读取文本
  --stdin                从 stdin 读取文本
  --play                 合成后用 aplay 自动播放
  --json                 打印完整 JSON 响应
  -l, --list-voices      列出可用音色
  -h, --help             显示帮助

注意：默认模型语速偏慢，建议在 -s 中包含"语速很快"。

VoiceDesign 示例（默认模型，用 -s 描述音色）：
  ax.ts tts "你好，欢迎使用小米TTS"
  ax.ts tts -s "新闻联播女播音员，字正腔圆的央视播音腔，端庄大气，语速很快" "各位观众晚上好。"
  ax.ts tts -s "温柔治愈的年轻女声，像深夜电台主播，语速较快" "晚安，愿你有个好梦。"
  ax.ts tts -s "年迈的说书先生，嗓音沙哑沧桑，语速缓慢" "话说那是很久很久以前..."

如需用预置音色，切换到标准 TTS 模型：
  ax.ts tts -m mimo-v2.5-tts -v 冰糖 "今天天气真好"

模型列表：
  mimo-v2.5-tts-voicedesign 文本设计音色（默认，推荐）
  mimo-v2.5-tts            标准 TTS（预置音色，-v 选音色）
  mimo-v2.5-tts-voiceclone  音频复刻音色
  mimo-v2-tts               V2 旧版 TTS

定价：TTS 全系列限时免费。
`;

// ─── vault helper ────────────────────────────────────────────────────
function vaultGet(key: string): string {
  const r = Bun.spawnSync(["ax.ts", "vault", "get", key], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    console.error(`vault get ${key} failed: ${r.stderr.toString().trim()}`);
    process.exit(1);
  }
  return r.stdout.toString().trim();
}

// ─── Arguments ───────────────────────────────────────────────────────
interface Args {
  text: string;
  voice: string;
  model: string;
  style?: string;
  out: string;
  format: string;
  file?: string;
  readStdin: boolean;
  json: boolean;
  play: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    text: "",
    voice: DEFAULT_VOICE,
    model: DEFAULT_MODEL,
    out: DEFAULT_OUT_DIR,
    format: DEFAULT_FORMAT,
    readStdin: false,
    json: false,
    play: false,
  };
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`选项 ${a} 缺少参数`); process.exit(1); }
      return v;
    };
    switch (a) {
      case "-v":
      case "--voice": out.voice = next(); break;
      case "-m":
      case "--model": out.model = next(); break;
      case "-s":
      case "--style": out.style = next(); break;
      case "-o":
      case "--out": out.out = next(); break;
      case "--format": {
        const f = next();
        if (f !== "wav" && f !== "pcm16") { console.error(`不支持的格式: ${f}（可选 wav | pcm16）`); process.exit(1); }
        out.format = f;
        break;
      }
      case "-f":
      case "--file": out.file = next(); break;
      case "--stdin": out.readStdin = true; break;
      case "--play": out.play = true; break;
      case "--json": out.json = true; break;
      case "-l":
      case "--list-voices": listVoices(); process.exit(0);
      case "-h":
      case "--help": console.log(HELP); process.exit(0);
      default:
        if (a.startsWith("-")) { console.error(`未知选项: ${a}\n\n${HELP}`); process.exit(1); }
        parts.push(a);
    }
  }
  out.text = parts.join(" ").trim();
  return out;
}

function listVoices() {
  console.log("V2.5 预置音色（mimo-v2.5-tts）：\n");
  const idWidth = Math.max(...Object.keys(V25_VOICES).map((k) => Buffer.byteLength(k)));
  for (const [id, v] of Object.entries(V25_VOICES)) {
    const pad = " ".repeat(idWidth - Buffer.byteLength(id) + 2);
    console.log(`  ${id}${pad}${v.name}  ${v.lang}  ${v.gender}`);
  }
  console.log("\nV2 预置音色（mimo-v2-tts）：\n");
  for (const [id, name] of Object.entries(V2_VOICES)) {
    const pad = " ".repeat(idWidth - Buffer.byteLength(id) + 2);
    console.log(`  ${id}${pad}${name}`);
  }
}

// ─── Build messages & audio (model-aware) ────────────────────────────
function buildMessages(args: Args): Array<{ role: string; content: string }> {
  const isVoiceDesign = args.model === "mimo-v2.5-tts-voicedesign";
  const messages: Array<{ role: string; content: string }> = [];

  if (isVoiceDesign) {
    // VoiceDesign: user message is the voice design prompt (mandatory)
    // Falls back to a default prompt if -s not given
    messages.push({ role: "user", content: args.style || DEFAULT_VOICE_DESIGN });
  } else if (args.style) {
    // Standard / voiceclone: user message is optional style instruction
    messages.push({ role: "user", content: args.style });
  }

  messages.push({ role: "assistant", content: args.text });
  return messages;
}

function buildAudio(args: Args): Record<string, unknown> {
  const audio: Record<string, unknown> = { format: args.format };

  if (args.model === "mimo-v2.5-tts-voicedesign") {
    // VoiceDesign: no voice field, supports optimize_text_preview
    return audio;
  }

  // Standard TTS & voiceclone: include voice
  audio.voice = args.voice;
  return audio;
}

// ─── Read text from file ─────────────────────────────────────────────
async function readFileText(path: string): Promise<string> {
  const f = Bun.file(path);
  if (!(await f.exists())) { console.error(`文件不存在: ${path}`); process.exit(1); }
  return (await f.text()).trim();
}

// ─── Read text from stdin ────────────────────────────────────────────
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return "";
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged).trim();
}

// ─── ts stamp ──────────────────────────────────────────────────────
function tsStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ─── Play audio ──────────────────────────────────────────────────────
function isWsl(): boolean {
  return Bun.spawnSync(["uname", "-r"], { stdout: "pipe" }).stdout.toString().includes("microsoft");
}

async function playAudio(filePath: string) {
  // WSL: use Windows WPF MediaPlayer (no window, native audio device)
  if (isWsl()) {
    const r = Bun.spawnSync(["wslpath", "-w", filePath], { stdout: "pipe" });
    if (r.exitCode === 0) {
      const winPath = r.stdout.toString().trim();
      // Escape single quotes for powershell
      const safePath = winPath.replace(/'/g, "''");
      const ps = `
Add-Type -AssemblyName PresentationCore
$done = $false
$player = New-Object System.Windows.Media.MediaPlayer
$player.Volume = 1.0
Register-ObjectEvent $player MediaOpened -Action { $Event.Sender.Play() } | Out-Null
Register-ObjectEvent $player MediaEnded -Action { $Event.Sender.Close(); $global:done = $true } | Out-Null
$player.Open('${safePath}')
for ($i=0; $i -lt 120 -and -not $done; $i++) {
  Start-Sleep -Milliseconds 500
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)
}
`;
      const proc = Bun.spawn(["powershell.exe", "-WindowStyle", "Hidden", "-c", ps],
        { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      proc.unref();
      return;
    }
  }

  // Native Linux
  const players = ["aplay", "ffplay", "paplay"];
  for (const player of players) {
    const r = Bun.spawnSync(["which", player], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) {
      const args = player === "ffplay" ? ["-nodisp", "-autoexit", filePath] : [filePath];
      Bun.spawn([player, ...args], { stdout: "ignore", stderr: "ignore" });
      return;
    }
  }
  console.error("未找到音频播放器（aplay / ffplay / paplay），跳过播放。");
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Collect text from all sources
  const sources: string[] = [];
  if (args.text) sources.push(args.text);
  if (args.file) sources.push(await readFileText(args.file));
  if (args.readStdin) sources.push(await readStdin());

  // Auto-read stdin if no text and stdin is piped
  if (sources.length === 0 && !process.stdin.isTTY) {
    sources.push(await readStdin());
  }

  args.text = sources.join("\n").trim();
  if (!args.text) { console.error("请提供文本。\n\n" + HELP); process.exit(1); }

  const apiKey = vaultGet(VAULT_KEY);

  // Detect Token Plan (tp- prefix) vs pay-as-you-go
  const isTokenPlan = apiKey.startsWith("tp-");
  const baseUrl = isTokenPlan ? TP_BASE_CN : API_BASE;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Token Plan uses api-key header; pay-as-you-go accepts both
  if (isTokenPlan) {
    headers["api-key"] = apiKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // ── Build request body ──
  const body: Record<string, unknown> = {
    model: args.model,
    messages: buildMessages(args),
    audio: buildAudio(args),
  };

  // ── Call API ──
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const respText = await res.text();
  let json: any;
  try { json = JSON.parse(respText); } catch { json = null; }

  if (!res.ok || json?.error || json?.code) {
    const err = json?.error?.message ?? json?.message ?? respText;
    console.error(`MiMo API error ${res.status}: ${err}`);
    process.exit(1);
  }

  if (args.json) { console.log(JSON.stringify(json, null, 2)); return; }

  // ── Extract audio ──
  const audioData = json?.choices?.[0]?.message?.audio?.data;
  if (!audioData) {
    console.error(`未在响应中找到音频数据:\n${JSON.stringify(json, null, 2)}`);
    process.exit(1);
  }

  const audioBytes = Buffer.from(audioData, "base64");

  // ── Output ──
  if (args.out === "-") {
    console.log(audioData);
    return;
  }

  const ext = args.format === "pcm16" ? "pcm" : "wav";
  const isFile = new RegExp(`\\.(${ext}|wav|pcm)$`, "i").test(args.out);
  let dest: string;

  if (isFile) {
    dest = args.out;
  } else {
    await mkdir(args.out, { recursive: true });
    dest = resolve(args.out, `${tsStamp()}.${ext}`);
  }

  await Bun.write(dest, audioBytes);
  console.log(dest);

  if (args.play) {
    await playAudio(dest);
  }
}

main();
