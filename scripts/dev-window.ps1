<#
.SYNOPSIS
  Opens a separate test copy of VS Code with this checkout of Checklist Bridge loaded.

.DESCRIPTION
  Your installed VS Code, your installed copy of the extension, ~\.checklist-bridge and ~\.claude are not touched.
  Everything the test window needs lives in one folder (default: ~\cb-dev), including its own Claude Code settings.
  The first time, run `claude` in the test window's terminal and sign in.

.EXAMPLE
  .\scripts\dev-window.ps1
  .\scripts\dev-window.ps1 -Fresh        # start again from nothing (deletes the cb-dev folder)
  .\scripts\dev-window.ps1 -SkipBuild    # you already ran npm run build
  .\scripts\dev-window.ps1 -Editor "C:\path\to\Code.exe"
#>
param(
  [string]$Editor,
  [string]$Base = (Join-Path $HOME 'cb-dev'),
  [switch]$Fresh,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Find VS Code. (A `code` command that points at another editor is not used on purpose.)
if (-not $Editor) {
  $Editor = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe", "$env:ProgramFiles\Microsoft VS Code\Code.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Editor -or -not (Test-Path $Editor)) {
  throw 'Could not find VS Code. Install it from https://code.visualstudio.com, or pass -Editor "C:\path\to\Code.exe".'
}

if ($Fresh -and (Test-Path $Base)) {
  if ((Split-Path -Leaf $Base) -ne 'cb-dev') { throw "-Fresh only deletes a folder named cb-dev. Not deleting $Base." }
  Remove-Item -Recurse -Force $Base
}

if (-not $SkipBuild) {
  Push-Location $root
  try {
    if (-not (Test-Path 'node_modules')) { npm ci; if ($LASTEXITCODE) { throw 'npm ci failed.' } }
    npm run build
    if ($LASTEXITCODE) { throw 'npm run build failed.' }
  } finally { Pop-Location }
}

$scratch = Join-Path $Base 'scratch'
$userDir = Join-Path $Base 'vscode\User'
New-Item -ItemType Directory -Force $scratch, $userDir | Out-Null

# Keep the test window from replacing the test build with the released version.
$settings = Join-Path $userDir 'settings.json'
if (-not (Test-Path $settings)) {
  [IO.File]::WriteAllText($settings, "{`n  `"checklistBridge.autoUpdate`": false`n}`n")
}

# Point the extension and Claude Code at the test folder, only for the window started below.
$names = 'CHECKLIST_BRIDGE_HOME', 'CLAUDE_CONFIG_DIR'
$saved = @{}
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  $env:CHECKLIST_BRIDGE_HOME = Join-Path $Base 'home'
  $env:CLAUDE_CONFIG_DIR = Join-Path $Base 'claude'
  & $Editor "--extensionDevelopmentPath=$root" "--user-data-dir=$(Join-Path $Base 'vscode')" "--extensions-dir=$(Join-Path $Base 'exts')" $scratch
} finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
}

Write-Host ''
Write-Host 'Test window opened. In it: open the terminal, run `claude` (sign in the first time), then ask for a checklist.'
Write-Host "Everything it uses is in $Base. Delete that folder when you're done, or run this script with -Fresh."
