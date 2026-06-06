$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootPattern = [regex]::Escape($root)

Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -in @("node.exe", "cloudflared.exe")) -and
    ($_.CommandLine -match $rootPattern -or $_.ExecutablePath -match $rootPattern)
  } |
  ForEach-Object {
    Write-Host "Stopping PID $($_.ProcessId): $($_.Name)"
    Stop-Process -Id $_.ProcessId -Force
  }

Write-Host "Done."
