#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AX = resolve(__dirname, "../../bin/ax.ts");
const SESSION = "zhipin";
const LOGIN_URL = "https://www.zhipin.com/web/user/?ka=header-login";

const STATE_DIR = resolve(homedir(), ".ax", "zhipin");
const COOKIE_FILE = resolve(STATE_DIR, "cookie.txt");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const PROXY = process.env.ZHIPIN_PROXY; // 可选；直连不通时用，如 http://10.0.0.1:7890

const CITY_CODES: Record<string, string> = {
  全国: "100010000", 北京: "101010100", 上海: "101020100", 广州: "101280100",
  深圳: "101280600", 杭州: "101210100", 成都: "101270100", 武汉: "101200100",
  南京: "101190100", 苏州: "101190400", 西安: "101110100", 天津: "101030100",
  重庆: "101040100", 长沙: "101250100", 郑州: "101180100",
};

// ── PowerShell / Windows ──────────────────────────────────────────────────────

function ps(cmd: string) {
  const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
  return { stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim(), ok: r.exitCode === 0 };
}
let _profile: string | undefined;
function winUserProfile() {
  if (!_profile) { const r = ps("$env:USERPROFILE"); if (!r.ok || !r.stdout) throw new Error("无法读取 Windows USERPROFILE"); _profile = r.stdout; }
  return _profile;
}
const profileDir = () => `${winUserProfile()}\\.ax\\sessions\\${SESSION}`;
function findChrome() {
  const r = ps(`Get-ChildItem '${winUserProfile()}\\.ax\\browsers' -Filter chrome.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`);
  if (!r.ok || !r.stdout) throw new Error("未找到 Chrome for Testing，先跑 `ax.ts agent-browser install`");
  return r.stdout;
}
function killProfileChrome() {
  ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*sessions\\${SESSION}*' } | ForEach-Object { taskkill.exe /T /F /PID $_.ProcessId *> $null }`);
}
function clearLocks() {
  ps(`Remove-Item '${profileDir()}\\SingletonLock','${profileDir()}\\SingletonCookie','${profileDir()}\\SingletonSocket' -Force -ErrorAction SilentlyContinue`);
}

// ── login：不带调试端口的普通 Chrome，供用户手动登录（BOSS 检测不到自动化）─────

async function login() {
  Bun.spawnSync(["bun", AX, "agent-browser", "--session", SESSION, "close"], { stdout: "pipe", stderr: "pipe" });
  killProfileChrome();
  clearLocks();
  const exe = findChrome();
  const flags = [`--user-data-dir=${profileDir()}`, "--no-first-run", "--no-default-browser-check", "--disable-features=Translate", LOGIN_URL];
  const argList = flags.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
  const r = ps(`Start-Process '${exe}' -ArgumentList @(${argList})`);
  if (!r.ok) throw new Error(`启动 Chrome 失败：${r.stderr}`);
  console.log(`已打开普通 Chrome（无调试端口，BOSS 检测不到）。请在窗口中手动登录（账号密码 / 扫码 + 验证）。

登录成功后，关闭该窗口，然后执行一次：
  ax.ts zhipin sync        # 抓取登录 cookie
之后即可：
  ax.ts zhipin search "<关键词>"`);
}

// ── sync：开 CDP 停在 about:blank，用浏览器级 Network.getAllCookies 取全部 cookie ──
// 绝不加载职位页 → 不触发 BOSS 的反爬「内存炸弹」；Chrome 自解密，绕过 App-Bound 加密。

async function cdpAllCookies(port: number): Promise<any[]> {
  const targets = await (await fetch(`http://localhost:${port}/json`)).json();
  const page = targets.find((t: any) => t.type === "page") ?? targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("找不到 CDP page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const res: any = await new Promise((ok, rej) => {
    const t = setTimeout(() => rej(new Error("CDP 超时")), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));
    ws.onmessage = (e) => { const m = JSON.parse((e.data as any).toString()); if (m.id === 1) { clearTimeout(t); ok(m); } };
    ws.onerror = () => { clearTimeout(t); rej(new Error("CDP WebSocket 错误")); };
  });
  ws.close();
  return res.result?.cookies ?? [];
}

async function sync(opts: { json: boolean }): Promise<string> {
  // 释放 profile 占用（可能有登录窗口或上次的 CDP Chrome）
  Bun.spawnSync(["bun", AX, "agent-browser", "--session", SESSION, "close"], { stdout: "pipe", stderr: "pipe" });
  killProfileChrome();
  clearLocks();
  // 开 CDP，停在 about:blank
  const proc = Bun.spawn(["bun", AX, "agent-browser", "--session", SESSION, "navigate", "about:blank"], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  // 找端口
  let port = 0;
  for (let p = 19222; p <= 19321; p++) {
    try { if ((await fetch(`http://localhost:${p}/json/version`, { signal: AbortSignal.timeout(400) })).ok) { port = p; break; } } catch {}
  }
  if (!port) throw new Error("CDP 端口未就绪");
  const cookies = (await cdpAllCookies(port)).filter((c: any) => /zhipin\.com/.test(c.domain));
  Bun.spawnSync(["bun", AX, "agent-browser", "--session", SESSION, "close"], { stdout: "pipe", stderr: "pipe" });

  const header = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  if (!header.includes("zp_at=")) throw new Error("没拿到登录 cookie（zp_at）。先 `ax.ts zhipin login` 登录并关闭窗口后再 sync。");
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  await Bun.write(COOKIE_FILE, header);
  if (opts.json) console.log(JSON.stringify({ ok: true, cookies: cookies.length }));
  else console.log(`已保存 ${cookies.length} 个 cookie（含登录态）。现在可以 search 了。`);
  return header;
}

// ── HTTP（纯 fetch，带 cookie，不开浏览器、不渲染页面）──────────────────────────

function loadJar(): string {
  if (!existsSync(COOKIE_FILE)) throw new Error("还没有 cookie。先 `ax.ts zhipin login` 登录，再 `ax.ts zhipin sync`。");
  return readFileSync(COOKIE_FILE, "utf8").trim();
}

// 原始 GET（带 cookie，直连失败兜底走代理），返回响应体文本。
async function rawGet(url: string, referer: string, accept = "application/json, text/plain, */*"): Promise<string> {
  const doFetch = (proxy?: string) => fetch(url, {
    headers: {
      cookie: loadJar(), "user-agent": UA, accept,
      "accept-language": "zh-CN,zh;q=0.9", referer, "x-requested-with": "XMLHttpRequest",
    },
    redirect: "manual",
    ...(proxy ? { proxy } : {}),
  });
  let res: Response;
  try { res = await doFetch(PROXY); }
  catch (e) { if (PROXY) throw e; res = await doFetch("http://10.0.0.1:7890"); } // 直连失败兜底走代理
  return await res.text();
}

async function apiGet(url: string, referer: string): Promise<any> {
  const body = await rawGet(url, referer);
  let data: any;
  try { data = JSON.parse(body); }
  catch { throw new Error(`返回非 JSON，可能 cookie 失效，重新 \`ax.ts zhipin sync\`。`); }
  if (data.code === 37 || data.code === 5001 || /verify/i.test(data.message ?? "")) {
    throw new Error(`被风控/需验证（code=${data.code}）。重新 \`ax.ts zhipin login\` 过验证后 \`sync\`。`);
  }
  if (data.code !== 0) throw new Error(`接口报错 code=${data.code} ${data.message ?? ""}`);
  return data.zpData;
}

// ── search ────────────────────────────────────────────────────────────────────

interface Job {
  title: string; salary: string; company: string; area: string; experience: string;
  degree: string; tags: string[]; boss: string; bossTitle: string; outsource: boolean; url: string; id: string;
}

function mapJob(j: any): Job {
  return {
    title: j.jobName, salary: j.salaryDesc, company: j.brandName,
    area: [j.cityName, j.areaDistrict, j.businessDistrict].filter(Boolean).join(""),
    experience: j.jobExperience, degree: j.jobDegree,
    // tags 用技能；没有技能时退回 jobLabels（去掉与经验/学历重复的项）
    tags: (j.skills?.length ? j.skills : (j.jobLabels ?? []).filter((l: string) => l !== j.jobExperience && l !== j.jobDegree)).filter(Boolean),
    boss: j.bossName, bossTitle: j.bossTitle,
    outsource: j.proxyJob === 1 || /猎头|外包/.test(j.bossTitle ?? ""),
    url: `https://www.zhipin.com/job_detail/${j.encryptJobId}.html`, id: j.encryptJobId,
  };
}

function printJobs(jobs: Job[], header: string) {
  console.log(`\n${header}\n`);
  jobs.forEach((j, i) => {
    console.log(`  [${i + 1}] ${j.title}   ${j.salary}${j.outsource ? "   〔外包/猎头〕" : ""}`);
    console.log(`      ${j.company}${j.area ? "  ·  " + j.area : ""}  ·  ${[j.experience, j.degree].filter(Boolean).join(" / ")}`);
    if (j.tags.length) console.log(`      ${j.tags.join(" / ")}`);
    console.log(`      HR：${j.boss}${j.bossTitle ? "（" + j.bossTitle + "）" : ""}`);
    console.log(`      ${j.url}\n`);
  });
}

async function search(query: string, opts: { city: string; limit: number; json: boolean }) {
  const code = CITY_CODES[opts.city] ?? opts.city;
  const ref = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(query)}&city=${code}`;
  const all: any[] = [];
  for (let page = 1; all.length < opts.limit && page <= 10; page++) {
    const api = `https://www.zhipin.com/wapi/zpgeek/search/joblist.json?scene=1&query=${encodeURIComponent(query)}&city=${code}&page=${page}&pageSize=30`;
    const zp = await apiGet(api, ref);
    const list: any[] = zp?.jobList ?? [];
    all.push(...list);
    if (!zp?.hasMore || !list.length) break;
    await Bun.sleep(600);
  }
  const jobs = all.slice(0, opts.limit).map(mapJob);
  if (opts.json) { console.log(JSON.stringify({ query, city: opts.city, count: jobs.length, jobs }, null, 2)); return; }
  if (!jobs.length) { console.log("没有结果。"); return; }
  printJobs(jobs, `BOSS 直聘搜索：${query} · ${opts.city} · ${jobs.length} 条`);
}

// ── recommend：登录后系统推荐的职位流 ──────────────────────────────────────────

async function recommend(opts: { limit: number; json: boolean }) {
  const ref = "https://www.zhipin.com/web/geek/job-recommend";
  const all: any[] = [];
  for (let page = 1; all.length < opts.limit && page <= 10; page++) {
    const api = `https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json?page=${page}&pageSize=30&jobType=0`;
    const zp = await apiGet(api, ref);
    const list: any[] = zp?.jobList ?? zp?.list ?? [];
    all.push(...list);
    if (!list.length || zp?.hasMore === false) break;
    await Bun.sleep(600);
  }
  const jobs = all.slice(0, opts.limit).map(mapJob);
  if (opts.json) { console.log(JSON.stringify({ count: jobs.length, jobs }, null, 2)); return; }
  if (!jobs.length) { console.log("暂无推荐。"); return; }
  printJobs(jobs, `BOSS 推荐职位 · ${jobs.length} 条`);
}

// ── detail：拉单个职位完整 JD（详情页是 SSR HTML，fetch 取文本解析，不渲染→不 OOM）──

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}
function pick(html: string, re: RegExp): string {
  const m = html.match(re);
  return m ? decodeHtml(m[1].replace(/<[^>]+>/g, "").trim()) : "";
}
function extractIdFromUrl(s: string): string {
  const m = s.match(/job_detail\/([^.\/?]+)\.html/) ?? s.match(/\/job\/([^.\/?]+)/);
  return m ? m[1] : s.replace(/\.html$/, "");
}

async function detail(idOrUrl: string, opts: { json: boolean }) {
  const id = /^https?:/.test(idOrUrl) ? extractIdFromUrl(idOrUrl) : idOrUrl.replace(/\.html$/, "");
  const url = `https://www.zhipin.com/job_detail/${id}.html`;
  const html = await rawGet(url, "https://www.zhipin.com/web/geek/job", "text/html,application/xhtml+xml");

  // JD：可能有多段 .job-sec-text（职位描述 + 公司介绍），<br> 转换行后拼接
  const jd = [...html.matchAll(/<div class="job-sec-text">([\s\S]*?)<\/div>/g)]
    .map((m) => decodeHtml(m[1].replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")).trim())
    .filter(Boolean).join("\n\n");

  const tagBlock = html.match(/class="[^"]*job-tags"[^>]*>([\s\S]*?)<\/div>/);
  const tags = tagBlock ? [...tagBlock[1].matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map((m) => decodeHtml(m[1].trim())).filter(Boolean) : [];

  const d = {
    id,
    title: pick(html, /<div class="name"><h1[^>]*>([^<]+)<\/h1>/) || pick(html, /<h1[^>]*title="([^"]+)"/),
    salary: pick(html, /<span class="salary">([^<]+)<\/span>/),
    company: pick(html, /<span class="brand-name">([^<]+)<\/span>/) || pick(html, /class="[^"]*company-info[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/),
    city: pick(html, /class="[^"]*text-city"[^>]*>([^<]+)</),
    experience: pick(html, /class="[^"]*text-experiece"[^>]*>([^<]+)</),
    degree: pick(html, /class="[^"]*text-degree"[^>]*>([^<]+)</),
    tags,
    jd,
    url,
  };

  if (opts.json) { console.log(JSON.stringify(d, null, 2)); return; }
  if (!d.title && !d.jd) {
    console.log("未解析到详情（可能被验证拦截或职位已下线）。先 `ax.ts zhipin login` 过验证再 `sync`。");
    return;
  }
  console.log(`\n${d.title}   ${d.salary}`);
  const meta = [d.company, d.city, d.experience, d.degree].filter(Boolean).join("  ·  ");
  if (meta) console.log(meta);
  if (d.tags.length) console.log(`标签：${d.tags.join(" / ")}`);
  if (d.jd) console.log(`\n【职位描述】\n${d.jd}`);
  console.log(`\n${d.url}`);
}

// ── chat：向职位发布者发起沟通（打招呼）──────────────────────────────────────────
// 接口：GET /wapi/zpgeek/friend/add.json?securityId=&jobId= （securityId 从详情页实时取）
// 默认 dry-run 只打印；--send 才真正发出（给真人 HR 发消息，不可撤销）。
// 开场白用账号设置里的默认「打招呼语」；自定义首条消息走 WebSocket，本版暂不做。

async function chat(idOrUrl: string, opts: { send: boolean; json: boolean }) {
  const id = /^https?:/.test(idOrUrl) ? extractIdFromUrl(idOrUrl) : idOrUrl.replace(/\.html$/, "");
  const detailUrl = `https://www.zhipin.com/job_detail/${id}.html`;
  const html = await rawGet(detailUrl, "https://www.zhipin.com/web/geek/job", "text/html,application/xhtml+xml");
  if (html.length < 1000) throw new Error("详情页为空（多半被验证拦截）。先 `ax.ts zhipin login` 过验证再 `sync`。");

  const title = pick(html, /<div class="name"><h1[^>]*>([^<]+)<\/h1>/) || pick(html, /<h1[^>]*title="([^"]+)"/);
  const salary = pick(html, /<span class="salary">([^<]+)<\/span>/);
  const company = pick(html, /<span class="brand-name">([^<]+)<\/span>/);

  const m = html.match(/data-url="(\/wapi\/zpgeek\/friend\/add\.json\?[^"]+)"/);
  if (!m) {
    if (/继续沟通/.test(html)) throw new Error(`「${title}」你已经打过招呼了（页面显示「继续沟通」），去 BOSS 沟通列表回复即可。`);
    throw new Error("没找到「立即沟通」接口（职位可能已下线，或需先过验证）。");
  }
  const addUrl = "https://www.zhipin.com" + m[1].replace(/&amp;/g, "&");

  const ctx = `${title}　${salary}${company ? "　" + company : ""}`;
  if (!opts.send) {
    if (opts.json) { console.log(JSON.stringify({ dryRun: true, job: { id, title, salary, company }, request: { method: "GET", url: addUrl } }, null, 2)); return; }
    console.log(`【dry-run，未发送】\n职位：${ctx}\n将要请求：GET ${addUrl}\n开场白：用你账号设置里的默认「打招呼语」\n\n确认要发起沟通就加 --send：\n  ax.ts zhipin chat ${id} --send`);
    return;
  }

  const zp = await apiGet(addUrl, detailUrl);
  if (opts.json) { console.log(JSON.stringify({ ok: true, job: { id, title }, zpData: zp }, null, 2)); return; }
  console.log(`✅ 已向「${ctx}」发起沟通。去 BOSS App / 网页版「沟通」里看 HR 是否回复。`);
}

function usage() {
  console.log(`Usage: ax.ts zhipin <command> [options]

Commands:
  login                    打开普通 Chrome 手动登录（绕过 BOSS 反爬）
  sync                     抓取登录 cookie（登录后跑一次；cookie 较持久）
  search <关键词> [opts]   搜索职位/项目（纯接口，不渲染页面）
  recommend [opts]         登录后系统推荐的职位流
  detail <url|职位id> [--json]   拉单个职位完整 JD（详情页 SSR HTML，解析提取）
  chat <url|职位id> [--send]     向职位发布者发起沟通（默认 dry-run，--send 才真发）

Options:
  --city <名称|code>   城市，默认 上海（${Object.keys(CITY_CODES).join("、")}，或直接传 code）
  --limit <n>          最多返回条数，默认 30
  --json               输出 JSON

首次流程：
  1) ax.ts zhipin login            # 弹窗手动登录，完了关窗口
  2) ax.ts zhipin sync             # 抓 cookie
  3) ax.ts zhipin search "Rust 外包" --city 上海
       （cookie 失效再重跑 sync 即可）`);
}

function flagVal(args: string[], name: string, def: string) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const json = args.includes("--json");
  const limit = Number(flagVal(args, "--limit", "30")) || 30;
  if (!cmd || args.includes("--help") || args.includes("-h")) { usage(); process.exit(cmd ? 0 : 1); }

  try {
    switch (cmd) {
      case "login": await login(); break;
      case "sync": await sync({ json }); break;
      case "search": {
        const query = args.slice(1).filter((a, i, arr) => !a.startsWith("--") && arr[i - 1] !== "--city" && arr[i - 1] !== "--limit").join(" ");
        if (!query) { usage(); process.exit(1); }
        await search(query, { city: flagVal(args, "--city", "上海"), limit, json });
        break;
      }
      case "recommend": await recommend({ limit, json }); break;
      case "detail": {
        const target = args.slice(1).find((a) => !a.startsWith("--"));
        if (!target) { console.error("用法：ax.ts zhipin detail <url|职位id>"); process.exit(1); }
        await detail(target, { json });
        break;
      }
      case "chat": {
        const target = args.slice(1).find((a) => !a.startsWith("--"));
        if (!target) { console.error("用法：ax.ts zhipin chat <url|职位id> [--send]"); process.exit(1); }
        await chat(target, { send: args.includes("--send"), json });
        break;
      }
      default: console.error(`未知命令：${cmd}`); usage(); process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}
