$ErrorActionPreference = "Stop"

$root = "C:\Users\36014\codex-edugov-helper"
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runLog = Join-Path $logs "public-on-logon-$runStamp.log"
$latestUrlFile = Join-Path $logs "latest-public-url.json"

function Write-RunLog {
  param([string]$Line)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $text = "[$timestamp] $Line"
  Add-Content -LiteralPath $runLog -Value $text -Encoding UTF8
  Write-Host $Line
}

Set-Location -LiteralPath $root

Write-RunLog "Working directory: $root"
Write-RunLog "Running: npm.cmd run stop-public"
& npm.cmd run stop-public 2>&1 | ForEach-Object {
  Write-RunLog $_.ToString()
}

Write-RunLog "Running: npm.cmd run public"
$reportedUrl = $false
& npm.cmd run public 2>&1 | ForEach-Object {
  $line = $_.ToString()
  Write-RunLog $line

  if (-not $reportedUrl -and $line -match "https://[a-zA-Z0-9-]+\.trycloudflare\.com") {
    $url = $Matches[0]
    $payload = [ordered]@{
      url = $url
      capturedAt = (Get-Date).ToString("o")
      sourceLog = $runLog
    }

    $payload | ConvertTo-Json | Set-Content -LiteralPath $latestUrlFile -Encoding UTF8
    Write-RunLog "Captured public URL: $url"
    $reportedUrl = $true
  }
}

Write-RunLog "npm.cmd run public exited with code $LASTEXITCODE"
exit $LASTEXITCODE
