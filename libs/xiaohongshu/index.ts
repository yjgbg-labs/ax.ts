#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AX = resolve(__dirname, "../../bin/ax.ts");
const SESSION = "xiaohongshu";
const LOGIN_URL = "https://creator.xiaohongshu.com/login";
const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish";

// ── ax.ts agent-browser wrapper ───────────────────────────────────────────────

async function ab(args: string[], opts?: { headed?: boolean; timeout?: number; ignoreError?: boolean }): Promise<string> {
  const cmd = ["bun", AX, "agent-browser", "--session", SESSION];
  if (opts?.headed) cmd.push("--headed");
  cmd.push(...args);
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = opts?.timeout ? setTimeout(() => proc.kill(), opts.timeout) : undefined;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if (timer) clearTimeout(timer);
  const code = await proc.exited;
  if (code !== 0 && !opts?.ignoreError) {
    throw new Error((err.trim() || out.trim() || `agent-browser exited ${code}`));
  }
  return out.trim();
}

async function closeBrowser(): Promise<void> {
  const proc = Bun.spawn(["bun", AX, "agent-browser", "--session", SESSION, "close"],
                         { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function currentUrl(): Promise<string> {
  return (await ab(["get", "url"])).trim();
}

// WSL path → Windows path. The native agent-browser binary lives in WSL but
// CDP-talks to Chrome on Windows; file paths sent via `upload` must be
// Windows-resolvable or Chrome will hang and the page crashes.
function toWinPath(p: string): string {
  if (/^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\")) return p;
  const r = Bun.spawnSync(["wslpath", "-w", p], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Cannot convert path to Windows form: ${p}`);
  return r.stdout.toString().trim();
}

// Pull the first ref capture-group match out of a snapshot dump.
function refFromSnapshot(snap: string, re: RegExp): string | null {
  const m = snap.match(re);
  return m?.[1] ?? null;
}

// All ref capture-group matches.
function refsFromSnapshot(snap: string, re: RegExp): string[] {
  return [...snap.matchAll(re)].map(m => m[1]);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function login(opts: { json: boolean }) {
  await ab(["navigate", PUBLISH_URL], { timeout: 30_000 });
  await Bun.sleep(2000);
  if (!(await currentUrl()).includes("/login")) {
    if (opts.json) console.log(JSON.stringify({ status: "ok", message: "Already logged in" }));
    else           console.log("Already logged in.");
    return;
  }
  await closeBrowser();
  await ab(["navigate", LOGIN_URL], { headed: true, timeout: 30_000 });
  await Bun.sleep(2000);
  if (opts.json) {
    console.log(JSON.stringify({ status: "pending", message: "请在浏览器中输入手机号和验证码完成登录", loginUrl: LOGIN_URL }));
    return;
  }
  console.log(`
============================================================
请在打开的浏览器窗口中完成登录：
  1. 输入手机号
  2. 点击「发送验证码」
  3. 输入验证码
  4. 勾选同意协议
  5. 点击「登 录」

登录成功后按 Enter 继续，或输入 'q' 退出...
============================================================
`);
  const decoder = new TextDecoder();
  const stdin = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await stdin.read();
    if (done) break;
    const input = decoder.decode(value).trim().toLowerCase();
    if (input === "q" || input === "quit") { console.log("Cancelled."); process.exit(0); }
    if (input === "") {
      if (!(await currentUrl()).includes("/login")) { console.log("Login successful!"); return; }
      console.log("Still on login page. Please complete login and press Enter again...");
    }
  }
}

async function status(opts: { json: boolean; headed: boolean }) {
  if (opts.headed) await closeBrowser();
  await ab(["navigate", PUBLISH_URL], { headed: opts.headed, timeout: 30_000 });
  await Bun.sleep(2000);
  const url = await currentUrl();
  const loggedIn = !url.includes("/login");
  if (opts.json) console.log(JSON.stringify({ loggedIn, currentUrl: url }));
  else           console.log(`Login status: ${loggedIn ? "Logged in" : "Not logged in"}`);
}

async function publish(opts: {
  images: string[];
  title?: string;
  tags?: string[];
  headed: boolean;
  json: boolean;
}) {
  if (opts.headed) await closeBrowser();

  // 1) Land on publish page; bail out if redirected to login.
  await ab(["navigate", PUBLISH_URL], { headed: opts.headed, timeout: 30_000 });
  await Bun.sleep(3000);
  if ((await currentUrl()).includes("/login")) {
    throw new Error("Not logged in. Run 'ax.ts xiaohongshu login' first.");
  }

  // 2) Switch to 图文 tab. There are TWO elements labeled "上传图文" — a
  // header link (no-op) and a body card (the real switcher). Snapshot,
  // collect both refs, click each — body card is whichever actually flips.
  let snap = await ab(["snapshot", "-i"], { timeout: 15_000 });
  const tabRefs = refsFromSnapshot(snap, /"上传图文".*ref=(e\d+)/g);
  if (!tabRefs.length) throw new Error("'上传图文' tab not found on publish page");
  for (const r of tabRefs) {
    try { await ab(["click", `@${r}`], { timeout: 5_000 }); } catch {}
  }
  await Bun.sleep(2000);

  // 3) Upload images (Windows-form paths only — CDP→Chrome resolves on Windows).
  if (!opts.images.length) throw new Error("at least one --images path is required");
  for (const img of opts.images) {
    const winPath = toWinPath(resolve(process.cwd(), img));
    await ab(["upload", 'input[type="file"]', winPath], { timeout: 60_000 });
    await Bun.sleep(2500);
  }

  // 4) Editor renders only AFTER upload — refs change, re-snapshot.
  await Bun.sleep(2500);
  snap = await ab(["snapshot", "-i"], { timeout: 15_000 });

  const titleRef   = refFromSnapshot(snap, /textbox "填写标题[^"]*" \[ref=(e\d+)\]/);
  // Body textbox: top-level (no leading indent), no quoted placeholder.
  const contentRef = refFromSnapshot(snap, /^- textbox \[ref=(e\d+)\]/m);
  const publishRef = refFromSnapshot(snap, /button "发布" \[ref=(e\d+)\]/);
  if (!publishRef) throw new Error("publish button not found after upload (editor not loaded?)");

  // 5) Optional title.
  if (opts.title && titleRef) {
    await ab(["fill", `@${titleRef}`, opts.title], { timeout: 8_000 });
    await Bun.sleep(400);
  }

  // 6) Body = hashtags only (each --tag → #tag, space-separated).
  if (opts.tags?.length && contentRef) {
    const tagLine = opts.tags.map(t => t.startsWith("#") ? t : `#${t}`).join(" ");
    await ab(["fill", `@${contentRef}`, tagLine], { timeout: 8_000 });
    await Bun.sleep(400);
  }

  // 7) Click 发布. No confirmation modal in the current flow — page navigates
  // straight to /publish/success.
  await ab(["click", `@${publishRef}`], { timeout: 8_000 });

  // 8) Wait for the success redirect.
  let finalUrl = "";
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    finalUrl = await currentUrl();
    if (finalUrl.includes("/publish/success") || !finalUrl.includes("/publish/publish")) break;
    await Bun.sleep(800);
  }

  const ok = !finalUrl.includes("/publish/publish");
  const out = ok
    ? { published: true,  title: opts.title || "", url: finalUrl }
    : { published: false, title: opts.title || "", url: finalUrl, error: "no /publish/success redirect within 25s" };

  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else if (ok)   console.log(`Published: ${out.title || "(untitled)"}\n  ${finalUrl}`);
  else           console.error(`Error: ${out.error}`);
  if (!ok) process.exit(1);
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage: xiaohongshu <command> [options]

Commands:
  login                Open headed browser for SMS login (session: 'xiaohongshu')
  status [--headed]    Check login status
  publish [opts]       Publish an image note
    --images <paths>     REQUIRED. Comma-separated image file paths (WSL paths OK; auto-converted)
    --tags <tags>        Comma-separated tags; sent as #hashtags in the body
    --title <text>       Optional note title (max 20 chars)
    --headed             Force a headed browser window (close + relaunch headed)
    --json               Output structured JSON

Browser:
  Runs in the wrapper session 'xiaohongshu'. Login uses a headed window;
  other commands default to headless. Manual control:
    ax.ts agent-browser --session xiaohongshu close
    ax.ts agent-browser --session xiaohongshu delete

Examples:
  ax.ts xiaohongshu login
  ax.ts xiaohongshu publish --images cover.jpg --tags "日常,生活"
  ax.ts xiaohongshu publish --images a.jpg,b.jpg --title "今日份快乐" --tags "plog,日常"
  ax.ts xiaohongshu publish --headed --images pic.jpg --tags "测试"
`);
}

// ── Arg parsing ────────────────────────────────────────────────────────────────

function parseArgs(args: string[]) {
  const result: Record<string, any> = { _: [] };
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--headed") { result.headed = true; i++; }
    else if (args[i] === "--json") { result.json = true; i++; }
    else if (args[i] === "--images" && args[i + 1]) { result.images = args[i + 1].split(",").map((s: string) => s.trim()); i += 2; }
    else if (args[i] === "--title" && args[i + 1]) { result.title = args[i + 1]; i += 2; }
    else if (args[i] === "--tags" && args[i + 1]) { result.tags = args[i + 1].split(",").map((s: string) => s.trim()); i += 2; }
    else { result._.push(args[i]); i++; }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs(rawArgs);
  const cmd = parsed._[0];

  try {
    switch (cmd) {
      case "login":
        await login({ json: !!parsed.json });
        break;
      case "status":
        await status({ json: !!parsed.json, headed: !!parsed.headed });
        break;
      case "publish":
        if (!parsed.images?.length) {
          console.error("Error: --images is required (one or more image paths, comma-separated)");
          process.exit(2);
        }
        await publish({
          images: parsed.images,
          title: parsed.title,
          tags: parsed.tags,
          headed: !!parsed.headed,
          json: !!parsed.json,
        });
        break;
      case "help":
      case "-h":
      case "--help":
        usage();
        break;
      default:
        if (cmd) console.error(`Unknown command: ${cmd}`);
        usage();
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
