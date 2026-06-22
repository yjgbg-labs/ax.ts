# ax-dlna mpv bridge: launch mpv fullscreen on Windows, hold its named-pipe IPC,
# accept line-delimited JSON commands from WSL on 127.0.0.1:<Port>.
param(
  [int]$Port = 8201,
  [string]$PipeName = "ax-dlna-mpv",
  [string]$MpvPath = "mpv"
)
$ErrorActionPreference = "Stop"

# DPI awareness for 4K displays
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D { [DllImport("Shcore.dll")] public static extern int SetProcessDpiAwareness(int v); }
"@
try { [D]::SetProcessDpiAwareness(2) | Out-Null } catch {}

$script:mpv = $null
$script:reader = $null
$script:writer = $null

function Stop-Mpv {
  if ($script:writer) { try { $script:writer.Dispose() } catch {} }
  if ($script:reader) { try { $script:reader.Dispose() } catch {} }
  $script:writer = $null; $script:reader = $null
  try { Get-Process mpv -ErrorAction SilentlyContinue | Stop-Process -Force } catch {}
  $script:mpv = $null
}

function Connect-Pipe {
  # 验证现有连接是否真的可用：mpv 已退出则管道必然失效
  if ($script:writer -and $script:mpv -and -not $script:mpv.HasExited) { return $true }
  # 旧连接无效，清理
  if ($script:writer) { try { $script:writer.Dispose() } catch {} }
  if ($script:reader) { try { $script:reader.Dispose() } catch {} }
  $script:writer = $null; $script:reader = $null
  if (-not $script:mpv -or $script:mpv.HasExited) { return $false }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    try {
      $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
      $pipe.Connect(500)
      $script:reader = New-Object System.IO.StreamReader($pipe, [System.Text.Encoding]::UTF8)
      $script:writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)))
      $script:writer.AutoFlush = $true
      return $true
    } catch { Start-Sleep -Milliseconds 200 }
  }
  return $false
}

function Start-Mpv([string]$Url) {
  Stop-Mpv
  $pipeArg = "--input-ipc-server=\\.\pipe\$PipeName"
  $mpvArgs = @(
    "--force-window=immediate", "--fullscreen", "--ontop", "--no-terminal",
    "--keep-open=no", "--idle=no", "--no-osc", "--osd-level=1",
    $pipeArg, "--", $Url
  )
  $script:mpv = Start-Process -FilePath $MpvPath -ArgumentList $mpvArgs -PassThru -WindowStyle Maximized
}

function Send-Mpv([string]$line) {
  if (-not (Connect-Pipe)) { return '{"error":"mpv_not_running"}' }
  $rid = $null
  if ($line -match '"request_id"\s*:\s*(\d+)') { $rid = $matches[1] }
  try { $script:writer.WriteLine($line) } catch { return '{"error":"write_failed"}' }
  if (-not $rid) { return '{"error":"success"}' }
  # 带超时的读取：mpv 正常 <100ms，给 3s 余量；超时则丢弃 writer 强制下次重连
  $deadline = (Get-Date).AddSeconds(3)
  while ((Get-Date) -lt $deadline) {
    try { $resp = $script:reader.ReadLine() } catch { return '{"error":"read_failed"}' }
    if ($null -eq $resp) { return '{"error":"pipe_closed"}' }
    if ($resp -match ('"request_id"\s*:\s*' + $rid + '\b')) { return $resp }
  }
  return '{"error":"mpv_timeout"}'
}

function Handle([string]$line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return '{"ok":false}' }
  try { $obj = $line | ConvertFrom-Json } catch { return '{"ok":false}' }
  switch ($obj._bridge) {
    "load" {
      if (-not $script:mpv -or $script:mpv.HasExited) {
        Start-Mpv $obj.url
      } else {
        $cmd = @{ command = @("loadfile", $obj.url, "replace"); request_id = 1 } | ConvertTo-Json -Compress
        Send-Mpv $cmd | Out-Null
      }
      return '{"ok":true}'
    }
    "quit" { Stop-Mpv; return '{"ok":true}' }
    "alive" {
      $running = ($script:mpv -and -not $script:mpv.HasExited)
      return (@{ ok = $true; running = $running } | ConvertTo-Json -Compress)
    }
    default {
      if (-not $script:mpv -or $script:mpv.HasExited) { return '{"error":"mpv_not_running"}' }
      return (Send-Mpv $line)
    }
  }
}

# Singleton: kill stale bridges and mpv on startup
try {
  Get-CimInstance Win32_Process -Filter "name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*ax-dlna-bridge.ps1*' -and $_.CommandLine -notlike '*-Command*' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Process mpv -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
} catch {}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch { Write-Output "[bridge] port $Port busy"; exit 1 }
Write-Output "[bridge] listening on 127.0.0.1:$Port pipe=$PipeName mpv=$MpvPath"

while ($true) {
  $client = $listener.AcceptTcpClient()
  $sr = New-Object System.IO.StreamReader($client.GetStream(), [System.Text.Encoding]::UTF8)
  $sw = New-Object System.IO.StreamWriter($client.GetStream(), (New-Object System.Text.UTF8Encoding($false)))
  $sw.AutoFlush = $true
  try {
    while ($null -ne ($req = $sr.ReadLine())) { $sw.WriteLine((Handle $req)) }
  } catch {} finally { try { $client.Close() } catch {} }
}
