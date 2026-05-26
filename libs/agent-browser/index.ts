#!/usr/bin/env bun
import { resolve } from "path";

const CDP_PORT = 19222;
const BIN = resolve(import.meta.dir, "node_modules/.bin/agent-browser");

const CHROME_FLAGS = [
  "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-backgrounding-occluded-windows",
  "--disable-component-update", "--disable-default-apps",
  "--disable-hang-monitor", "--disable-popup-blocking",
  "--disable-prompt-on-repost", "--disable-sync",
  "--disable-features=Translate",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--metrics-recording-only", "--password-store=basic",
  "--use-mock-keychain", "--disable-dev-shm-usage",
];

// ── PowerShell ────────────────────────────────────────────────────────────────

function ps(cmd: string) {
  const r = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd],
    { stdout: "pipe", stderr: "pipe" }
  );
  return { stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim(), ok: r.exitCode === 0 };
}

// ── Windows paths (lazy) ──────────────────────────────────────────────────────

let _userProfile: string;
function userProfile() {
  if (!_userProfile) {
    const r = ps("$env:USERPROFILE");
    if (!r.ok || !r.stdout) throw new Error("Cannot read USERPROFILE from Windows");
    _userProfile = r.stdout;
  }
  return _userProfile;
}

const installDir = () => process.env.CHROME_FOR_TESTING_DIR ?? `${userProfile()}\\.ax\\browsers`;
const profilesDir = () => `${userProfile()}\\.ax\\profiles`;
const versionFile = () => `${installDir()}\\version.txt`;

function toWinPath(p: string) {
  if (/^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\")) return p;
  const r = Bun.spawnSync(["wslpath", "-w", p], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Cannot convert path: ${p}`);
  return r.stdout.toString().trim();
}

// ── Chrome for Testing ────────────────────────────────────────────────────────

function findChrome() {
  const r = ps(`
    $e = Get-ChildItem '${installDir()}' -Filter chrome.exe -Recurse -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
    if ($e) { $e }
  `);
  return r.stdout || null;
}

function fetchLatest() {
  const r = ps(`
    $j = Invoke-RestMethod 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
    "$($j.channels.Stable.version)|$(($j.channels.Stable.downloads.chrome | Where-Object { $_.platform -eq 'win64' }).url)"
  `);
  if (!r.ok || !r.stdout) throw new Error("Failed to fetch Chrome for Testing version");
  const [version, url] = r.stdout.split("|");
  return { version, url };
}

async function ensureChrome(verbose = false, forceUpgrade = false): Promise<string> {
  // Fast path: existing chrome works fine, don't hit Google on every navigate.
  // Auto-upgrade only when explicitly requested via `install` / `upgrade` subcommand.
  if (!forceUpgrade) {
    const exe = findChrome();
    if (exe) return exe;
  }

  const { version, url } = fetchLatest();
  const dir = installDir();
  const installed = ps(`if (Test-Path '${versionFile()}') { Get-Content '${versionFile()}' }`).stdout;

  // Already up to date
  if (installed === version) {
    const exe = findChrome();
    if (exe) { if (verbose) console.log(`Already up to date: ${version}`); return exe; }
  }

  // Chrome exists but no version file → write it and skip download
  if (!installed) {
    const exe = findChrome();
    if (exe) {
      ps(`Set-Content '${versionFile()}' '${version}'`);
      if (verbose) console.log(`Version file updated (${version})`);
      return exe;
    }
  }

  if (verbose) console.log(`Downloading Chrome for Testing ${version}...`);
  const r = ps(`
    $ErrorActionPreference = 'Stop'
    try {
      New-Item -ItemType Directory '${dir}' -Force | Out-Null
      $zip = '${dir}\\chrome-win64.zip'
      Invoke-WebRequest '${url}' -OutFile $zip
      Expand-Archive $zip '${dir}' -Force -ErrorAction SilentlyContinue
      Remove-Item $zip -ErrorAction SilentlyContinue
      $e = Get-ChildItem '${dir}' -Filter chrome.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName
      if (-not $e) { throw 'chrome.exe not found' }
      $e
    } catch { Write-Error $_; exit 1 }
  `);
  if (!r.ok || !r.stdout) {
    // Download failed but maybe an older chrome is on disk — fall back to it.
    const fallback = findChrome();
    if (fallback) {
      if (verbose) console.error(`Download failed, using existing chrome:\n${r.stderr}`);
      return fallback;
    }
    throw new Error(`Download failed:\n${r.stderr}`);
  }
  ps(`Set-Content '${versionFile()}' '${version}'`);
  if (verbose) console.log(`Installed: ${r.stdout}`);
  return r.stdout;
}

// ── Chrome launch ─────────────────────────────────────────────────────────────

function preflight() {
  Bun.spawnSync([BIN, "close", "--all"], { stdout: "pipe", stderr: "pipe" });
  ps(`
    $c = Get-NetTCPConnection -LocalPort ${CDP_PORT} -ErrorAction SilentlyContinue
    if ($c) { $c | Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }
  `);
}

function launchChrome(exe: string, opts: ParseResult, userDataDir: string): number {
  const flags = [
    ...CHROME_FLAGS,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    ...(!opts.headed ? ["--headless=new", "--enable-unsafe-swiftshader"] : []),
    ...(opts.proxy ? [`--proxy-server=${opts.proxy}`] : []),
    ...(opts.proxyBypass ? [`--proxy-bypass-list=${opts.proxyBypass}`] : []),
    ...(opts.allowFileAccess ? ["--allow-file-access-from-files", "--allow-file-access"] : []),
    ...(opts.extensions.length ? [`--load-extension=${opts.extensions.map(toWinPath).join(",")}`] : []),
    ...opts.extraArgs,
  ];
  const args = flags.map(f => `'${f.replace(/'/g, "''")}'`).join(",");
  const r = ps(`$p = Start-Process '${exe}' -ArgumentList @(${args}) -PassThru; $p.Id`);
  const pid = parseInt(r.stdout);
  if (isNaN(pid)) throw new Error(`Failed to launch Chrome:\n${r.stderr}`);
  return pid;
}

async function waitForCDP(ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://localhost:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`Chrome CDP not ready after ${ms / 1000}s`);
}

// ── User data dir ─────────────────────────────────────────────────────────────

function resolveDataDir(profile?: string): { path: string; temp: boolean } {
  if (!profile) {
    const r = ps(`$d = "$env:TEMP\\ax-ab-$([guid]::NewGuid())"; New-Item $d -ItemType Directory -Force | Out-Null; $d`);
    if (!r.ok || !r.stdout) throw new Error("Failed to create temp dir");
    return { path: r.stdout, temp: true };
  }
  const dir = (profile.includes("/") || profile.includes("\\") || profile.startsWith("."))
    ? toWinPath(profile)
    : `${profilesDir()}\\${profile}`;
  ps(`New-Item '${dir}' -ItemType Directory -Force | Out-Null`);
  return { path: dir, temp: false };
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

interface ParseResult {
  headed: boolean;
  proxy?: string;
  proxyBypass?: string;
  allowFileAccess: boolean;
  extensions: string[];
  extraArgs: string[];
  profile?: string;
  executablePath?: string;
  rest: string[];
}

function parseArgs(argv: string[]): ParseResult {
  const r: ParseResult = {
    headed: process.env.AGENT_BROWSER_HEADED === "1",
    allowFileAccess: process.env.AGENT_BROWSER_ALLOW_FILE_ACCESS === "1",
    extensions: (process.env.AGENT_BROWSER_EXTENSIONS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    extraArgs: (process.env.AGENT_BROWSER_ARGS ?? "").split(/[,\n]/).map(s => s.trim()).filter(Boolean),
    proxy: process.env.AGENT_BROWSER_PROXY || process.env.HTTP_PROXY,
    proxyBypass: process.env.AGENT_BROWSER_PROXY_BYPASS || process.env.NO_PROXY,
    profile: process.env.AGENT_BROWSER_PROFILE,
    executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH,
    rest: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} requires a value`); return argv[++i]; };
    const val = (prefix: string) => a.startsWith(prefix + "=") ? a.slice(prefix.length + 1) : null;

    if (a === "--headed") {
      const n = argv[i + 1];
      if (n === "false") { r.headed = false; i++; } else { r.headed = true; if (n === "true") i++; }
    }
    else if (a === "--cdp") { i++; }
    else if (val("--cdp") !== null || a === "--auto-connect") { /* strip */ }
    else if (a === "--engine") { i++; }
    else if (val("--engine") !== null) { /* strip */ }
    else if (a === "--proxy")           { r.proxy = next(); }
    else if (val("--proxy"))            { r.proxy = val("--proxy")!; }
    else if (a === "--proxy-bypass")    { r.proxyBypass = next(); }
    else if (val("--proxy-bypass"))     { r.proxyBypass = val("--proxy-bypass")!; }
    else if (a === "--allow-file-access") { r.allowFileAccess = true; }
    else if (a === "--args")            { r.extraArgs.push(...next().split(/[,\n]/).map(s => s.trim()).filter(Boolean)); }
    else if (val("--args"))             { r.extraArgs.push(...val("--args")!.split(/[,\n]/).map(s => s.trim()).filter(Boolean)); }
    else if (a === "--extension")       { r.extensions.push(next()); }
    else if (val("--extension"))        { r.extensions.push(val("--extension")!); }
    else if (a === "--profile")         { r.profile = next(); }
    else if (val("--profile"))          { r.profile = val("--profile")!; }
    else if (a === "--executable-path") { r.executablePath = next(); }
    else if (val("--executable-path"))  { r.executablePath = val("--executable-path")!; }
    else { r.rest.push(a); }
  }
  return r;
}

// ── Built-in subcommands ──────────────────────────────────────────────────────

function doctor() {
  const dir = installDir();
  const chrome = findChrome();
  const version = ps(`if (Test-Path '${versionFile()}') { Get-Content '${versionFile()}' }`).stdout;
  const psVer = ps("$PSVersionTable.PSVersion.Major");
  const portInUse = ps(`(Test-NetConnection localhost -Port ${CDP_PORT} -WarningAction SilentlyContinue).TcpTestSucceeded`).stdout.toLowerCase() === "true";

  for (const [label, ok, detail] of [
    ["Chrome for Testing", !!chrome, chrome ?? "not found"],
    ["Installed version",  !!version, version || "unknown"],
    ["PowerShell",         psVer.ok,  psVer.ok ? `v${psVer.stdout}` : "not found"],
    [`Port ${CDP_PORT}`,   !portInUse, portInUse ? "in use" : "free"],
  ] as const) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}: ${detail}`);
  }
}

function profiles() {
  const r = ps(`
    if (Test-Path '${profilesDir()}') {
      Get-ChildItem '${profilesDir()}' -Directory | Select-Object -ExpandProperty Name
    }
  `);
  const names = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!names.length) console.log("No saved profiles. Use --profile <name> to create one.");
  else { console.log("Saved profiles:"); names.forEach(n => console.log(`  ${n}`)); }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function cdpAlive(): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv.find(a => !a.startsWith("-"));

  if (first === "install")  { await ensureChrome(true); return; }
  if (first === "upgrade")  {
    const { version } = fetchLatest();
    const installed = ps(`if (Test-Path '${versionFile()}') { Get-Content '${versionFile()}' }`).stdout;
    if (installed === version) { console.log(`Already at latest: ${version}`); return; }
    console.log(`Upgrading ${installed || "(unknown)"} → ${version}...`);
    await ensureChrome(false); console.log(`Done: ${version}`); return;
  }
  if (first === "profiles") { profiles(); return; }
  if (first === "doctor")   { doctor(); return; }

  // `close` shuts down whatever's running — don't launch a fresh browser first
  if (first === "close") {
    const proc = Bun.spawn([BIN, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }

  // Passthrough flags that don't need a browser
  if (argv.some(a => a === "--help" || a === "-h" || a === "--version" || a === "-V")) {
    const proc = Bun.spawn([BIN, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }

  const opts = parseArgs(argv);
  // Reuse existing browser if CDP is already up — lets multi-step workflows
  // share one session across invocations. The instance that launched the
  // browser owns its lifecycle; later invocations attach and don't clean up.
  const reuse = await cdpAlive();

  let pid: number | null = null;
  let dataDir: { path: string; temp: boolean } | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || reuse) return; cleaned = true;
    Bun.spawnSync([BIN, "close", "--all"], { stdout: "pipe", stderr: "pipe" });
    if (pid !== null) ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
    if (dataDir?.temp) ps(`Remove-Item '${dataDir.path}' -Recurse -Force -ErrorAction SilentlyContinue`);
  };

  process.on("SIGINT",  () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    if (!reuse) {
      const exe = opts.executablePath ? toWinPath(opts.executablePath) : await ensureChrome();
      dataDir = resolveDataDir(opts.profile);
      preflight();
      pid = launchChrome(exe, opts, dataDir.path);
      await waitForCDP();
    } else if (opts.profile || opts.executablePath || opts.extensions.length || opts.proxy) {
      console.error("Note: existing browser on CDP port reused; --profile/--proxy/--extension/--executable-path ignored. Run `ax.ts agent-browser close --all` first to apply new flags.");
    }

    const proc = Bun.spawn([BIN, "--cdp", String(CDP_PORT), ...opts.rest], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    const code = await proc.exited;

    // Headed launches leave the browser running so subsequent invocations
    // can reuse it. Headless launches always clean up. Reused sessions
    // never clean up (we don't own them).
    if (!reuse && !opts.headed) cleanup();
    process.exit(code);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    cleanup();
    process.exit(1);
  }
}

main();
