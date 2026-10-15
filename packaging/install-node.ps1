# Installs the my-claw node client on Windows (docs/remote-nodes.md). Served by the my-claw it
# joins:
#
#   powershell -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing 'https://myclaw.example/node/install-node.ps1' -OutFile $env:TEMP\install-node.ps1; & $env:TEMP\install-node.ps1 -Pair ABCD1234 -Server wss://myclaw.example/node"
#
# Run it from an elevated PowerShell for the admin install (Scheduled Task as SYSTEM at startup);
# from a normal one for the user install (Scheduled Task at logon, the user's own rights).
# The binary comes from the my-claw being joined, gated by the same claim code, so this machine
# needs no release key of its own. Re-run the same command to update.
param(
  [Parameter(Mandatory = $true)][string]$Pair,
  [Parameter(Mandatory = $true)][string]$Server,
  [ValidateSet("user", "admin")][string]$Mode = "",
  [string]$Name = "",
  [string]$Workdir = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $Mode) {
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $Mode = if ($identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { "admin" } else { "user" }
}
if ($Server -notmatch '^wss?://') {
  Write-Error "--Server must be a ws:// or wss:// URL"
  exit 1
}
$Server = $Server.TrimEnd('/')
$httpBase = ($Server -replace '^wss://', 'https://' -replace '^ws://', 'http://')

$target = "windows-x64"
$query = "target=$target"
if ($Version) { $query = "$query&version=$Version" }

$tmp = Join-Path $env:TEMP ("myclaw-node-" + [guid]::NewGuid().ToString('N') + ".exe")
Write-Host "Downloading the node client for $target..."
try {
  Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = "Bearer $Pair" } -Uri "$httpBase/download?$query" -OutFile $tmp
} catch {
  Write-Error "The download was refused. Is the code still valid (ten minutes, single use at pairing)? $_"
  exit 1
}

if ($Mode -eq "admin") {
  $bin = Join-Path $env:ProgramFiles "my-claw-node\myclaw-node.exe"
  $dir = Join-Path $env:ProgramData "my-claw-node"
} else {
  $bin = Join-Path $env:LOCALAPPDATA "my-claw-node\myclaw-node.exe"
  $dir = Join-Path $env:LOCALAPPDATA "my-claw-node"
}
New-Item -ItemType Directory -Force -Path (Split-Path $bin) | Out-Null
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Move-Item -Force $tmp $bin

$pairArgs = @("pair", "--server", $Server, "--code", $Pair, "--dir", $dir)
if ($Name) { $pairArgs += @("--name", $Name) }
if ($Workdir) { $pairArgs += @("--workdir", $Workdir) }
Write-Host "Pairing..."
& $bin @pairArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$taskCommand = "`"$bin`" run --dir `"$dir`""
if ($Mode -eq "admin") {
  schtasks /Create /F /TN "my-claw-node" /TR $taskCommand /SC ONSTART /RU SYSTEM /RL HIGHEST | Out-Null
} else {
  schtasks /Create /F /TN "my-claw-node" /TR $taskCommand /SC ONLOGON | Out-Null
}
schtasks /Run /TN "my-claw-node" | Out-Null

Write-Host ""
Write-Host "Node installed and paired ($Mode mode)."
Write-Host "Check it from the my-claw: myclaw node ls"
Write-Host "Status here: schtasks /Query /TN my-claw-node"
