#!/usr/bin/env bun

import { mkdir } from "fs/promises";
import { homedir } from "os";
import { resolve } from "path";

const VAULT_KEY = "text2image_apikey";
const DEFAULT_OUT_DIR = resolve(homedir(), "Pictures/ax-t2i");
const DEFAULT_MODEL = "wan2.7-image-pro";
const DEFAULT_SIZE = "1280*1280";

const WAN_ENDPOINTS = {
  beijing: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  intl: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  us: "https://dashscope-us.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
} as const;

const KLING_ENDPOINTS = {
  beijing: "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation",
  intl: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation",
  us: "https://dashscope-us.aliyuncs.com/api/v1/services/aigc/image-generation/generation",
} as const;

const TASK_ENDPOINTS = {
  beijing: "https://dashscope.aliyuncs.com/api/v1/tasks",
  intl: "https://dashscope-intl.aliyuncs.com/api/v1/tasks",
  us: "https://dashscope-us.aliyuncs.com/api/v1/tasks",
} as const;

type Region = keyof typeof WAN_ENDPOINTS;

const HELP = `Usage: ax.ts t2i [options] <prompt>

  根据 prompt 调用百炼文生图模型，默认下载到 ~/Pictures/ax-t2i/。
  同步类（wan / qwen-image / z-image，立即返回）与异步类（kling，轮询）均支持。

Options:
  -n <1-9>              生成张数（默认 1；按张计费）
  -s, --size <spec>     wan：分辨率 "W*H"（注意 zsh 需加引号）
                        kling：宽高比 "1:1" | "16:9" | "9:16"（默认 1:1）
                        也可传 "W*H"，自动换算宽高比
  --negative <text>     反向提示词（仅 wan 系列）
  --extend              开启 prompt_extend 智能改写（仅 wan，默认关，多耗 3-4s）
  --watermark           添加 "AI生成" 水印（仅 wan）
  --seed <int>          随机种子 [0, 2147483647]（仅 wan）
  --resolution <r>      kling 输出分辨率：1k | 2k（默认 1k）
  -o, --out <path>      输出目录或单文件路径；- 表示不下载，仅打印 URL
  --region <r>          beijing | intl | us（默认 beijing）
  --model <name>        默认 ${DEFAULT_MODEL}；完整可选见下方「可用模型」
  --json                打印完整 JSON 响应（wan：最终响应；kling：任务结果）

可用模型（--model，均已实测可用）：
  同步类（multimodal 端点，立即返回图片；--negative/--extend/--watermark/--seed 仅此类生效）：
    wan2.7-image-pro   通义万相 2.7 旗舰，写实最强、能渲染中文招牌/横幅（当前默认，推荐）
    wan2.7-image       通义万相 2.7 标准版
    wan2.6-t2i         通义万相 2.6（旧版）
    qwen-image-max     Qwen-Image 旗舰，强中文与排版
    z-image-turbo      极速出图，质量略低、最省钱
  异步类（kling/ 前缀，轮询任务、较慢；尺寸用 1:1|16:9|9:16，仅 --resolution 1k|2k 生效）：
    kling/kling-v3-image-generation       快手可灵 v3，偏电影暗调氛围
    kling/kling-v3-omni-image-generation  可灵 v3 omni

  发现更多模型（列出账号下所有可用 image 模型 ID）：
    curl -s https://dashscope.aliyuncs.com/compatible-mode/v1/models \\
      -H "Authorization: Bearer $(ax.ts vault get text2image_apikey)" \\
      | tr '{' '\\n' | grep -oE '"id":"[^"]*"' | grep -iE 'image|wan|kling'

wan 常用分辨率（同步类通用）：
  1:1  → 1280*1280    3:4 → 1104*1472    4:3 → 1472*1104
  9:16 →  960*1696   16:9 → 1696*960
`;

function vaultGet(key: string): string {
  const r = Bun.spawnSync(["ax.ts", "vault", "get", key], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    console.error(`vault get ${key} failed: ${r.stderr.toString().trim()}`);
    process.exit(1);
  }
  return r.stdout.toString().trim();
}

interface Args {
  prompt: string;
  n: number;
  size: string;
  negative?: string;
  extend: boolean;
  watermark: boolean;
  seed?: number;
  resolution: string;
  out: string;
  region: Region;
  model: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    prompt: "",
    n: 1,
    size: DEFAULT_SIZE,
    extend: false,
    watermark: false,
    resolution: "1k",
    out: DEFAULT_OUT_DIR,
    region: "beijing",
    model: DEFAULT_MODEL,
    json: false,
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
      case "-n": out.n = Number(next()); break;
      case "-s":
      case "--size": out.size = next(); break;
      case "--negative": out.negative = next(); break;
      case "--extend": out.extend = true; break;
      case "--watermark": out.watermark = true; break;
      case "--seed": out.seed = Number(next()); break;
      case "--resolution": out.resolution = next(); break;
      case "-o":
      case "--out": out.out = next(); break;
      case "--region": {
        const r = next();
        if (!(r in WAN_ENDPOINTS)) { console.error(`未知 region: ${r}（可选 beijing|intl|us）`); process.exit(1); }
        out.region = r as Region;
        break;
      }
      case "--model": out.model = next(); break;
      case "--json": out.json = true; break;
      case "-h":
      case "--help": console.log(HELP); process.exit(0);
      default:
        if (a.startsWith("-")) { console.error(`未知选项: ${a}\n\n${HELP}`); process.exit(1); }
        parts.push(a);
    }
  }
  out.prompt = parts.join(" ").trim();
  if (!out.prompt) { console.error("请提供 prompt。\n\n" + HELP); process.exit(1); }
  if (!Number.isInteger(out.n) || out.n < 1 || out.n > 9) { console.error("-n 必须是 1-9 的整数"); process.exit(1); }
  return out;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function sizeToAspectRatio(size: string): string {
  if (size.includes(":")) return size;
  const [w, h] = size.split("*").map(Number);
  if (!w || !h) { console.error(`无法解析尺寸: ${size}`); process.exit(1); }
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function tsStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function extractImageUrls(resp: any): string[] {
  const choices = resp?.output?.choices ?? [];
  const urls: string[] = [];
  for (const c of choices) {
    for (const part of c?.message?.content ?? []) {
      if (typeof part?.image === "string") urls.push(part.image);
    }
  }
  return urls;
}

async function pollTask(taskId: string, apiKey: string, region: Region): Promise<any> {
  const url = `${TASK_ENDPOINTS[region]}/${taskId}`;
  process.stderr.write("等待任务完成");
  for (let i = 0; i < 150; i++) {
    await Bun.sleep(2000);
    process.stderr.write(".");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const json = await res.json() as any;
    const status = json?.output?.task_status;
    if (status === "SUCCEEDED") { process.stderr.write("\n"); return json; }
    if (status === "FAILED") {
      process.stderr.write("\n");
      console.error(`任务失败: ${JSON.stringify(json?.output)}`);
      process.exit(1);
    }
  }
  process.stderr.write("\n");
  console.error("轮询超时（5 分钟）");
  process.exit(1);
}

async function downloadOne(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) { console.error(`下载失败 ${url}: ${res.status}`); process.exit(1); }
  await Bun.write(dest, res);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = vaultGet(VAULT_KEY);
  const isKling = args.model.startsWith("kling/");

  let json: any;

  if (isKling) {
    const parameters: Record<string, unknown> = {
      n: args.n,
      aspect_ratio: sizeToAspectRatio(args.size === DEFAULT_SIZE ? "1:1" : args.size),
      resolution: args.resolution,
    };

    const body = {
      model: args.model,
      input: { messages: [{ role: "user", content: [{ text: args.prompt }] }] },
      parameters,
    };

    const res = await fetch(KLING_ENDPOINTS[args.region], {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let created: any;
    try { created = JSON.parse(text); } catch { created = null; }

    if (!res.ok || created?.code) { console.error(`dashscope error ${res.status}: ${text}`); process.exit(1); }

    const taskId = created?.output?.task_id;
    if (!taskId) { console.error(`未获取到 task_id:\n${text}`); process.exit(1); }

    json = await pollTask(taskId, apiKey, args.region);
  } else {
    const parameters: Record<string, unknown> = {
      size: args.size,
      n: args.n,
      prompt_extend: args.extend,
      watermark: args.watermark,
    };
    if (args.negative) parameters.negative_prompt = args.negative;
    if (args.seed !== undefined) parameters.seed = args.seed;

    const body = {
      model: args.model,
      input: { messages: [{ role: "user", content: [{ text: args.prompt }] }] },
      parameters,
    };

    const res = await fetch(WAN_ENDPOINTS[args.region], {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }

    if (!res.ok || json?.code) { console.error(`dashscope error ${res.status}: ${text}`); process.exit(1); }
  }

  if (args.json) { console.log(JSON.stringify(json, null, 2)); return; }

  const urls = extractImageUrls(json);
  if (urls.length === 0) { console.error(`未在响应中找到图片 URL:\n${JSON.stringify(json)}`); process.exit(1); }

  if (args.out === "-") { for (const u of urls) console.log(u); return; }

  const isFile = /\.(png|jpg|jpeg|webp)$/i.test(args.out);
  if (isFile) {
    if (urls.length > 1) { console.error(`-o 指向单文件但返回了 ${urls.length} 张图，请改成目录或减小 -n`); process.exit(1); }
    await downloadOne(urls[0], args.out);
    console.log(args.out);
    return;
  }

  await mkdir(args.out, { recursive: true });
  const stamp = tsStamp();
  for (let i = 0; i < urls.length; i++) {
    const suffix = urls.length > 1 ? `-${i + 1}` : "";
    const dest = resolve(args.out, `${stamp}${suffix}.png`);
    await downloadOne(urls[i], dest);
    console.log(dest);
  }
}

main();
