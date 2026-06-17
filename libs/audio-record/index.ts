#!/usr/bin/env bun

const HELP = `Usage: ax.ts audio-record <command> [args...]

Commands:
  list                       列出 Windows 侧可用的音频捕获设备
  record <output> [options]  录制系统音频（Ctrl+C 停止）

Options:
  --device <name>            指定设备名（默认自动检测 Stereo Mix / 立体声混音）
  --duration <seconds>       录制时长（秒）
  --bitrate <rate>           音频码率（如 256k、320k），仅对有损格式生效
`;

async function checkFfmpeg(): Promise<boolean> {
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-Command", "ffmpeg -version"],
    { stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
  return proc.exitCode === 0;
}

async function getRawDeviceList(): Promise<string> {
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-Command", "ffmpeg -hide_banner -list_devices true -f dshow -i dummy 2>&1"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return stdout || stderr;
}

interface AudioDevice { name: string; alt?: string }

function parseAudioDevices(raw: string): AudioDevice[] {
  const lines = raw.split(/\r?\n/);
  const devices: AudioDevice[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\] "(.+?)"\s+\(audio\)/);
    if (m) {
      devices.push({ name: m[1] });
      const alt = lines[i + 1]?.match(/Alternative name "(.+)"/);
      if (alt) devices[devices.length - 1].alt = alt[1];
    }
  }
  return devices;
}

async function listDevices() {
  if (!(await checkFfmpeg())) {
    console.error("错误: Windows 侧未安装 ffmpeg");
    console.error("请运行: powershell.exe -Command 'winget install ffmpeg'");
    process.exit(1);
  }

  const raw = await getRawDeviceList();
  const devices = parseAudioDevices(raw);

  if (!devices.length) {
    console.log("未找到音频捕获设备");
    console.log("提示: 需要在 Windows 声音设置中启用 '立体声混音' (Stereo Mix)");
    return;
  }
  console.log("可用的音频捕获设备：");
  for (const d of devices) console.log(`  ${d.name}`);
}

async function toWindowsPath(wslPath: string): Promise<string> {
  if (wslPath.startsWith("/mnt/") || wslPath.includes(":\\")) return wslPath;
  const proc = Bun.spawn(["wslpath", "-w", wslPath], { stdout: "pipe" });
  const winPath = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return winPath || wslPath;
}

async function record(output: string, opts: { device?: string; duration?: number; bitrate?: string }) {
  if (!(await checkFfmpeg())) {
    console.error("错误: Windows 侧未安装 ffmpeg");
    console.error("请运行: powershell.exe -Command 'winget install ffmpeg'");
    process.exit(1);
  }

  let device = opts.device;
  if (!device) {
    const raw = await getRawDeviceList();
    const devices = parseAudioDevices(raw);
    const match = devices.find(d => /stereo mix|立体声混音|loopback/i.test(d.name));
    if (match) device = match.name;
    else if (devices.length) device = devices[0].name;
    if (!device) {
      console.error("未找到音频捕获设备，请用 --device 指定或使用 list 查看可用设备");
      process.exit(1);
    }
  }

  const absOutput = await toWindowsPath(output);
  console.log(`录制设备: ${device}`);
  console.log(`输出文件: ${absOutput}`);
  if (opts.duration) console.log(`录制时长: ${opts.duration}s`);
  else console.log("按 Ctrl+C 停止录制");
  if (opts.bitrate) console.log(`码率: ${opts.bitrate}`);

  const bitrateArg = opts.bitrate ? `-b:a ${opts.bitrate}` : "";
  const durationArgs = opts.duration ? `-t ${opts.duration}` : "";
  const ffmpegCmd = `ffmpeg -hide_banner -y -f dshow ${durationArgs} -i audio="${device}" ${bitrateArg} "${absOutput}"`;

  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-Command", ffmpegCmd],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  );

  process.exit(await proc.exited);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "list":
    await listDevices();
    break;
  case "record": {
    let output: string | undefined;
    let device: string | undefined;
    let duration: number | undefined;
    let bitrate: string | undefined;
    const rest = [...args];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === "--device") device = rest.shift();
      else if (arg === "--duration") duration = Number(rest.shift());
      else if (arg === "--bitrate") bitrate = rest.shift();
      else if (!output) output = arg;
    }
    if (!output) {
      console.error("Usage: ax.ts audio-record record <output> [--device <name>] [--duration <s>] [--bitrate <rate>]");
      process.exit(1);
    }
    await record(output, { device, duration, bitrate });
    break;
  }
  default:
    console.log(HELP);
    process.exit(cmd ? 1 : 0);
}
