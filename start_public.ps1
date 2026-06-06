$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$preferredPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$port = $preferredPort
while (Test-NetConnection -ComputerName "127.0.0.1" -Port $port -InformationLevel Quiet) {
  Write-Host "Port $port is already in use; trying $($port + 1)."
  $port += 1
  if ($port -gt ($preferredPort + 20)) {
    throw "No available port found from $preferredPort to $port"
  }
}
$env:HOST = "127.0.0.1"
$env:PORT = "$port"
if (-not $env:MOBILE_TOKEN) {
  $env:MOBILE_TOKEN = "20050804"
}

$cloudflared = Join-Path $root "tools\cloudflared.exe"
if (-not (Test-Path -LiteralPath $cloudflared)) {
  throw "cloudflared.exe not found: $cloudflared"
}

$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$outLog = Join-Path $logs "mobile-service.out.log"
$errLog = Join-Path $logs "mobile-service.err.log"

Write-Host ""
Write-Host "Starting mobile publish service on http://127.0.0.1:$port"
Write-Host "Password: $($env:MOBILE_TOKEN)"
Write-Host ""

$mobile = Start-Process `
  -FilePath "npm.cmd" `
  -ArgumentList @("run", "mobile") `
  -WorkingDirectory $root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru `
  -WindowStyle Hidden

Start-Sleep -Seconds 3
if ($mobile.HasExited) {
  Write-Host "Mobile service failed to start. Logs:"
  if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Tail 40 }
  if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Tail 40 }
  exit 1
}

Write-Host "Cloudflare Tunnel is starting."
Write-Host "Copy the https://*.trycloudflare.com address below and open it on your phone."
Write-Host "Press Ctrl+C in this window to stop the public tunnel and mobile service."
Write-Host ""

try {
  & $cloudflared tunnel --url "http://127.0.0.1:$port"
}
finally {
  if ($mobile -and -not $mobile.HasExited) {
    Stop-Process -Id $mobile.Id -Force -ErrorAction SilentlyContinue
  }
}
