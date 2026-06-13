# ax-dlna mpv 桥接：在 Windows 侧全屏拉起 mpv，持有其命名管道 IPC，
# 同时在 127.0.0.1:<Port> 上接受 WSL 发来的行分隔 JSON 命令并转发给 mpv。
# mirrored WSL 下 localhost 在 Windows/WSL 间互通，故 WSL 可廉价连本端口。
param(
  [int]$Port = 8201,
  [string]$PipeName = "ax-dlna-mpv",
  [string]$MpvPath = "mpv"
)
$ErrorActionPreference = "Stop"

# DPI 感知，保证全屏在 4K 缩放屏上是原生像素
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D { [DllImport("Shcore.dll")] public static extern int SetProcessDpiAwareness(int v); }
"@
try { [D]::SetProcessDpiAwareness(2) | Out-Null } catch {}

$script:mpv = $null
$script:pipe = $null
$script:reader = $null
$script:writer = $null

function Stop-Mpv {
  if ($script:writer) { try { $script:writer.Dispose() } catch {} }
  if ($script:reader) { try { $script:reader.Dispose() } catch {} }
  if ($script:pipe)   { try { $script:pipe.Dispose() } catch {} }
  $script:writer = $null; $script:reader = $null; $script:pipe = $null
  # 单例：清掉所有 mpv（本渲染器独占屏幕播放），杜绝空闲孤儿叠加
  try { Get-Process mpv -ErrorAction SilentlyContinue | Stop-Process -Force } catch {}
  $script:mpv = $null
}

function Start-Mpv([string]$Url) {
  Stop-Mpv
  # 带文件直接启动、idle=no：放完自动退出关窗，不留空闲孤儿窗口
  $mpvArgs = @(
    "--force-window=immediate",
    "--fullscreen",
    "--ontop",
    "--no-terminal",
    "--keep-open=no",
    "--idle=no",
    "--no-osc",
    "--osd-level=1",
    "--input-ipc-server=\\.\pipe\$PipeName",
    "--",
    $Url
  )
  $script:mpv = Start-Process -FilePath $MpvPath -ArgumentList $mpvArgs -PassThru -WindowStyle Maximized
  # 连接 mpv 的命名管道用于控制（mpv 起来需要一点时间）
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    try {
      $p = New-Object System.IO.Pipes.NamedPipeClientStream(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
      $p.Connect(500)
      $script:pipe = $p
      $script:reader = New-Object System.IO.StreamReader($p, [System.Text.Encoding]::UTF8)
      $enc = New-Object System.Text.UTF8Encoding($false)
      $script:writer = New-Object System.IO.StreamWriter($p, $enc)
      $script:writer.AutoFlush = $true
      return $true
    } catch { Start-Sleep -Milliseconds 200 }
  }
  # 连不上控制管道：保留 mpv 继续播放（控制降级），不杀
  return $true
}

# 向 mpv 发送一行 JSON 命令，读取并返回匹配 request_id 的那行响应（跳过异步事件）
function Send-Mpv([string]$line) {
  if (-not $script:writer) { return '{"error":"mpv_not_running"}' }
  $rid = $null
  if ($line -match '"request_id"\s*:\s*(\d+)') { $rid = $matches[1] }
  try {
    $script:writer.WriteLine($line)
  } catch { return '{"error":"write_failed"}' }
  if ($null -eq $rid) { return '{"error":"success"}' }
  while ($true) {
    $resp = $null
    try { $resp = $script:reader.ReadLine() } catch { return '{"error":"read_failed"}' }
    if ($null -eq $resp) { return '{"error":"pipe_closed"}' }
    if ($resp -match ('"request_id"\s*:\s*' + $rid + '\b')) { return $resp }
    # 否则是事件行，忽略，继续读
  }
}

# 处理来自 WSL 的一条桥接指令；返回要回给 WSL 的一行
function Handle([string]$line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return '{"ok":false}' }
  try { $obj = $line | ConvertFrom-Json } catch { return '{"ok":false,"err":"bad_json"}' }
  switch ($obj._bridge) {
    "load" {
      if (-not $script:mpv -or $script:mpv.HasExited) {
        # 没在跑：带 URL 启动（不留空闲窗口）
        Start-Mpv $obj.url | Out-Null
      } else {
        # 已在跑：原地换片
        $cmd = @{ command = @("loadfile", $obj.url, "replace"); request_id = 1 } | ConvertTo-Json -Compress
        Send-Mpv $cmd | Out-Null
      }
      return '{"ok":true}'
    }
    "quit" {
      Stop-Mpv
      return '{"ok":true}'
    }
    "alive" {
      $a = ($script:mpv -and -not $script:mpv.HasExited)
      return (@{ ok = $true; running = $a } | ConvertTo-Json -Compress)
    }
    default {
      # 透传给 mpv（已是完整 mpv IPC JSON），把 mpv 的响应原样回传
      if (-not $script:mpv -or $script:mpv.HasExited) { return '{"error":"mpv_not_running"}' }
      return (Send-Mpv $line)
    }
  }
}

# 单例：启动时杀掉其它 ax-dlna bridge（除自己）和所有 mpv，确保全局只有这一个 bridge
try {
  Get-CimInstance Win32_Process -Filter "name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*ax-dlna-bridge.ps1*' -and $_.CommandLine -notlike '*-Command*' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Process mpv -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
} catch {}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
  $listener.Start()
} catch {
  Write-Output "[bridge] port $Port busy, exiting: $_"
  exit 1
}
Write-Output "[bridge] listening on 127.0.0.1:$Port pipe=$PipeName mpv=$MpvPath"

while ($true) {
  $client = $listener.AcceptTcpClient()
  $stream = $client.GetStream()
  $sr = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
  $sw = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
  $sw.AutoFlush = $true
  try {
    while ($null -ne ($req = $sr.ReadLine())) {
      $out = Handle $req
      $sw.WriteLine($out)
    }
  } catch {} finally {
    try { $client.Close() } catch {}
  }
}
