#!/usr/bin/env bun
import { resolve } from "path";

const CDP_PORT_BASE = 19222;
const CDP_PORT_MAX  = 19321;
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

const installDir     = () => process.env.CHROME_FOR_TESTING_DIR ?? `${userProfile()}\\.ax\\browsers`;
const sessionsRoot   = () => `${userProfile()}\\.ax\\sessions`;
const winSessionDir  = (n: string) => `${sessionsRoot()}\\${n}`;
const versionFile    = () => `${installDir()}\\version.txt`;

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
  if (!forceUpgrade) {
    const exe = findChrome();
    if (exe) return exe;
  }
  const { version, url } = fetchLatest();
  const dir = installDir();
  const installed = ps(`if (Test-Path '${versionFile()}') { Get-Content '${versionFile()}' }`).stdout;
  if (installed === version) {
    const exe = findChrome();
    if (exe) { if (verbose) console.log(`Already up to date: ${version}`); return exe; }
  }
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

// ── Session discovery (process table = source of truth) ───────────────────────

interface ActiveSession { name: string; pid: number; port: number }

function validateSessionName(n: string) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(n)) {
    throw new Error(`Invalid session name '${n}' (allowed: [A-Za-z0-9._-], max 64 chars)`);
  }
}

// Scan all chrome.exe processes once, correlate cmdline --user-data-dir with
// who owns a listening TCP socket. Returns one entry per active session.
function listActiveSessions(): ActiveSession[] {
  // PS single-quoted strings don't escape backslashes; only single quotes need doubling.
  const rootRaw = sessionsRoot().replace(/'/g, "''");
  const r = ps(`
    $pat = [regex]::Escape('${rootRaw}\\') + '([A-Za-z0-9._-]+)'
    $listenByPid = @{}
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $listenByPid.ContainsKey([int]$_.OwningProcess)) {
        $listenByPid[[int]$_.OwningProcess] = [int]$_.LocalPort
      }
    }
    $seen = @{}
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.CommandLine -and $_.CommandLine -match $pat) {
        $name = $matches[1]
        $procId = [int]$_.ProcessId
        if (-not $seen.ContainsKey($name) -and $listenByPid.ContainsKey($procId)) {
          $seen[$name] = $true
          "$name|$procId|$($listenByPid[$procId])"
        }
      }
    }
  `);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
    const [name, pid, port] = line.split("|");
    return { name, pid: Number(pid), port: Number(port) };
  });
}

function lookupSession(name: string): { pid: number; port: number } | null {
  const found = listActiveSessions().find(s => s.name === name);
  return found ? { pid: found.pid, port: found.port } : null;
}

function listSessionDirsOnDisk(): string[] {
  const r = ps(`
    if (Test-Path '${sessionsRoot()}') {
      Get-ChildItem '${sessionsRoot()}' -Directory -ErrorAction SilentlyContinue |
        Select-Object -Expand Name
    }
  `);
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// ── Port allocation / process kill ────────────────────────────────────────────

function portIsFree(port: number): boolean {
  const r = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  return !r.stdout.trim();
}

function findFreePort(): number {
  for (let p = CDP_PORT_BASE; p <= CDP_PORT_MAX; p++) {
    if (portIsFree(p)) return p;
  }
  throw new Error(`No free CDP port in [${CDP_PORT_BASE}..${CDP_PORT_MAX}]`);
}

function killTree(pid: number) {
  ps(`& taskkill.exe /T /F /PID ${pid} *> $null`);
}

// ── Chrome launch ─────────────────────────────────────────────────────────────

function ensureSessionDataDir(name: string): string {
  const dir = winSessionDir(name);
  // Wipe stale singleton locks (left by a previously crashed Chrome) before relaunch.
  ps(`
    New-Item '${dir}' -ItemType Directory -Force | Out-Null
    Remove-Item '${dir}\\SingletonLock','${dir}\\SingletonCookie','${dir}\\SingletonSocket' -Force -ErrorAction SilentlyContinue
  `);
  return dir;
}

function launchChrome(exe: string, opts: ParseResult, userDataDir: string, port: number) {
  const flags = [
    ...CHROME_FLAGS,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...(!opts.headed ? ["--headless=new", "--enable-unsafe-swiftshader"] : []),
    ...(opts.proxy ? [`--proxy-server=${opts.proxy}`] : []),
    ...(opts.proxyBypass ? [`--proxy-bypass-list=${opts.proxyBypass}`] : []),
    ...(opts.allowFileAccess ? ["--allow-file-access-from-files", "--allow-file-access"] : []),
    ...(opts.extensions.length ? [`--load-extension=${opts.extensions.map(toWinPath).join(",")}`] : []),
    ...opts.extraArgs,
  ];
  const args = flags.map(f => `'${f.replace(/'/g, "''")}'`).join(",");
  // Don't capture the launcher PID — it exits immediately. The real browser
  // process is discovered later via the process-table scan.
  const r = ps(`Start-Process '${exe}' -ArgumentList @(${args}) | Out-Null`);
  if (!r.ok) throw new Error(`Failed to launch Chrome:\n${r.stderr}`);
}

async function waitForCDP(port: number, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${ms / 1000}s`);
}

async function ensureSession(name: string, opts: ParseResult): Promise<{ port: number; reused: boolean }> {
  validateSessionName(name);

  const existing = lookupSession(name);
  if (existing) return { port: existing.port, reused: true };

  const dir = ensureSessionDataDir(name);
  const exe = opts.executablePath ? toWinPath(opts.executablePath) : await ensureChrome();
  const port = findFreePort();
  launchChrome(exe, opts, dir, port);
  await waitForCDP(port);
  return { port, reused: false };
}

async function closeSession(name: string) {
  validateSessionName(name);
  const found = lookupSession(name);
  if (!found) { console.log(`Session '${name}' not running`); return; }

  // Let upstream's daemon drop its connection for this session first.
  Bun.spawnSync([BIN, "--cdp", String(found.port), "--session", name, "close"],
                { stdout: "pipe", stderr: "pipe" });
  killTree(found.pid);
  console.log(`Closed session '${name}'`);
}

async function deleteSession(name: string) {
  validateSessionName(name);
  await closeSession(name);                  // kill process tree first (no-op if stopped)
  const dir = winSessionDir(name);
  const r = ps(`
    if (Test-Path '${dir}') {
      Remove-Item '${dir}' -Recurse -Force -ErrorAction Stop
      Write-Host 'removed'
    } else { Write-Host 'absent' }
  `);
  if (!r.ok) { console.error(`Failed to delete '${name}': ${r.stderr}`); return; }
  if (r.stdout.trim() === "removed") console.log(`Deleted session '${name}' data dir`);
  else                               console.log(`Session '${name}' has no data dir`);
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

interface ParseResult {
  session?: string;
  headed: boolean;
  proxy?: string;
  proxyBypass?: string;
  allowFileAccess: boolean;
  extensions: string[];
  extraArgs: string[];
  executablePath?: string;
  rest: string[];
}

const REMOVED_FLAGS = new Set(["--profile", "--session-name", "--state", "--auto-connect"]);

function parseArgs(argv: string[]): ParseResult {
  const r: ParseResult = {
    session: process.env.AGENT_BROWSER_SESSION,
    headed: process.env.AGENT_BROWSER_HEADED === "1",
    allowFileAccess: process.env.AGENT_BROWSER_ALLOW_FILE_ACCESS === "1",
    extensions: (process.env.AGENT_BROWSER_EXTENSIONS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    extraArgs: (process.env.AGENT_BROWSER_ARGS ?? "").split(/[,\n]/).map(s => s.trim()).filter(Boolean),
    proxy: process.env.AGENT_BROWSER_PROXY || process.env.HTTP_PROXY,
    proxyBypass: process.env.AGENT_BROWSER_PROXY_BYPASS || process.env.NO_PROXY,
    executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH,
    rest: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} requires a value`); return argv[++i]; };
    const val  = (prefix: string) => a.startsWith(prefix + "=") ? a.slice(prefix.length + 1) : null;
    const head = a.split("=")[0];

    if (REMOVED_FLAGS.has(head)) {
      throw new Error(`${head} is no longer supported by this wrapper; everything routes through --session <name>. See \`ax.ts agent-browser --help\` (wrapper) for the simplified model.`);
    }

    if (a === "--session")              { r.session = next(); }
    else if (val("--session"))          { r.session = val("--session")!; }
    else if (a === "--headed") {
      const n = argv[i + 1];
      if (n === "false") { r.headed = false; i++; } else { r.headed = true; if (n === "true") i++; }
    }
    else if (a === "--cdp" || a === "--engine") { i++; }   // strip — wrapper controls
    else if (val("--cdp") !== null || val("--engine") !== null) { /* strip */ }
    else if (a === "--proxy")           { r.proxy = next(); }
    else if (val("--proxy"))            { r.proxy = val("--proxy")!; }
    else if (a === "--proxy-bypass")    { r.proxyBypass = next(); }
    else if (val("--proxy-bypass"))     { r.proxyBypass = val("--proxy-bypass")!; }
    else if (a === "--allow-file-access") { r.allowFileAccess = true; }
    else if (a === "--args")            { r.extraArgs.push(...next().split(/[,\n]/).map(s => s.trim()).filter(Boolean)); }
    else if (val("--args"))             { r.extraArgs.push(...val("--args")!.split(/[,\n]/).map(s => s.trim()).filter(Boolean)); }
    else if (a === "--extension")       { r.extensions.push(next()); }
    else if (val("--extension"))        { r.extensions.push(val("--extension")!); }
    else if (a === "--executable-path") { r.executablePath = next(); }
    else if (val("--executable-path"))  { r.executablePath = val("--executable-path")!; }
    else { r.rest.push(a); }
  }
  return r;
}

// ── Built-in subcommands ──────────────────────────────────────────────────────

function doctor() {
  const chrome = findChrome();
  const version = ps(`if (Test-Path '${versionFile()}') { Get-Content '${versionFile()}' }`).stdout;
  const psVer = ps("$PSVersionTable.PSVersion.Major");
  for (const [label, ok, detail] of [
    ["Chrome for Testing", !!chrome,  chrome ?? "not found"],
    ["Installed version",  !!version, version || "unknown"],
    ["PowerShell",         psVer.ok,  psVer.ok ? `v${psVer.stdout}` : "not found"],
    ["Sessions root",      true,      sessionsRoot()],
    ["Port range",         true,      `${CDP_PORT_BASE}..${CDP_PORT_MAX}`],
  ] as const) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}: ${detail}`);
  }
}

function sessionsCmd() {
  const onDisk = listSessionDirsOnDisk();
  const active = new Map(listActiveSessions().map(s => [s.name, s] as const));
  const all = new Set([...onDisk, ...active.keys()]);
  if (!all.size) { console.log("No sessions. Use --session <name> to create one."); return; }
  console.log("Sessions:");
  for (const n of [...all].sort()) {
    const a = active.get(n);
    const status = a ? `running (pid=${a.pid}, port=${a.port})` : `stopped`;
    console.log(`  ${n.padEnd(24)} ${status}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Flags that consume the next argv as their value. Used by findSubcommand
// to skip past flag values (e.g. in `--session w close`, the subcommand is
// `close`, not `w`). Kept in sync with parseArgs below.
const VALUE_FLAGS = new Set(["--session", "--proxy", "--proxy-bypass", "--extension", "--args", "--executable-path", "--cdp", "--engine"]);

function findSubcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      const head = a.split("=")[0];
      if (VALUE_FLAGS.has(head) && !a.includes("=")) i++;   // also skip its value
      continue;
    }
    return a;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const first = findSubcommand(argv);

  // Session-free subcommands
  if (first === "install")  { await ensureChrome(true); return; }
  if (first === "upgrade")  {
    const { version } = fetchLatest();
    const installed = ps(`if (Test-Path '${versionFile()}') { Get-Content '${versionFile()}' }`).stdout;
    if (installed === version) { console.log(`Already at latest: ${version}`); return; }
    console.log(`Upgrading ${installed || "(unknown)"} → ${version}...`);
    await ensureChrome(false, true); console.log(`Done: ${version}`); return;
  }
  if (first === "doctor")   { doctor(); return; }
  if (first === "session") {
    // Find the next non-flag arg after `session` (must also skip flag-values).
    const after = argv.slice(argv.indexOf(first) + 1);
    const sub = findSubcommand(after);
    if (sub === "list") { sessionsCmd(); return; }
    console.error("Usage: ax.ts agent-browser session list");
    process.exit(2);
  }
  if (first === "sessions" || first === "profiles") {
    console.error(`'${first}' was removed. Use 'session list' instead.`);
    process.exit(2);
  }

  if (first === "close") {
    let opts: ParseResult;
    try { opts = parseArgs(argv); }
    catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(2); }
    if (!opts.session) {
      console.error("close requires --session <name>");
      process.exit(2);
    }
    await closeSession(opts.session);
    return;
  }

  if (first === "delete") {
    let opts: ParseResult;
    try { opts = parseArgs(argv); }
    catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(2); }
    if (!opts.session) {
      console.error("delete requires --session <name>");
      process.exit(2);
    }
    await deleteSession(opts.session);
    return;
  }

  // Help / version pass through (no browser needed)
  if (argv.some(a => a === "--help" || a === "-h" || a === "--version" || a === "-V")) {
    const proc = Bun.spawn([BIN, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }

  let opts: ParseResult;
  try { opts = parseArgs(argv); }
  catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(2); }

  if (!opts.session) {
    console.error("Error: --session <name> is required (or set AGENT_BROWSER_SESSION).");
    console.error("Example: ax.ts agent-browser --session work navigate https://example.com");
    process.exit(2);
  }

  let port: number, reused: boolean;
  try { ({ port, reused } = await ensureSession(opts.session, opts)); }
  catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(1); }

  if (reused) {
    const wanted: string[] = [];
    if (opts.headed)              wanted.push("--headed");
    if (opts.proxy)               wanted.push("--proxy");
    if (opts.proxyBypass)         wanted.push("--proxy-bypass");
    if (opts.allowFileAccess)     wanted.push("--allow-file-access");
    if (opts.extensions.length)   wanted.push("--extension");
    if (opts.extraArgs.length)    wanted.push("--args");
    if (opts.executablePath)      wanted.push("--executable-path");
    if (wanted.length) {
      console.error(`Note: session '${opts.session}' reused; launch flags (${wanted.join(", ")}) ignored. Run \`ax.ts agent-browser close --session ${opts.session}\` first to relaunch with new flags.`);
    }
  }

  const proc = Bun.spawn([BIN, "--cdp", String(port), "--session", opts.session, ...opts.rest], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await proc.exited);
}

main();
