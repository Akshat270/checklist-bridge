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
$Base = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Base) # a relative -Base means relative to where you ran this from

# Find VS Code. (A `code` command that points at another editor is not used on purpose.)
if (-not $Editor) {
  $Editor = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe", "$env:ProgramFiles\Microsoft VS Code\Code.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Editor -or -not (Test-Path $Editor)) {
  throw 'Could not find VS Code. Install it from https://code.visualstudio.com, or pass -Editor "C:\path\to\Code.exe".'
}

# VS Code won't start while it is installing an update ("Code is currently being updated"), and the test window
# would silently not open. Say so instead. The lock's name comes from the editor's own product.json (stable is
# "vscode", Insiders "vscodeinsiders"); it sits next to Code.exe, or in a folder named after the build in newer versions.
# -Editor may also be bin\code.cmd, one folder down: then look from the folder above bin.
$editorDir = Split-Path -Parent $Editor
if ((Split-Path -Leaf $editorDir) -eq 'bin') { $editorDir = Split-Path -Parent $editorDir }
$product = @(Join-Path $editorDir 'resources\app\product.json') +
  @(Get-ChildItem -Directory $editorDir -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'resources\app\product.json' }) |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $product) { Write-Warning "Could not find VS Code's product.json near $Editor, so the script can't tell whether VS Code is updating." }
$mutexName = if ($product) { (Get-Content -Raw $product | ConvertFrom-Json).win32MutexName }
$updating = $null
if ($mutexName -and [System.Threading.Mutex]::TryOpenExisting("$mutexName-updating", [ref]$updating)) {
  $updating.Dispose()
  throw 'VS Code is installing an update. Wait for it to finish (or restart VS Code to apply it), then run this script again.'
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

$built = try { git -C $root log -1 --format='%h %s' 2>$null } catch { $null }
Write-Host "Built commit: $(if ($built) { $built } else { 'unknown' })"
$scratch = Join-Path $Base 'scratch'
$userDir = Join-Path $Base 'vscode\User'
New-Item -ItemType Directory -Force $scratch, $userDir | Out-Null

# Keep the test window from replacing the test build with the released version: turn autoUpdate off unless the
# test profile already says something about it.
$settings = Join-Path $userDir 'settings.json'
$off = "  `"checklistBridge.autoUpdate`": false"
if (-not (Test-Path $settings) -or -not ([IO.File]::ReadAllText($settings)).Trim()) {
  [IO.File]::WriteAllText($settings, "{`n$off`n}`n")
} elseif (([IO.File]::ReadAllText($settings)) -notmatch 'checklistBridge\.autoUpdate') {
  [IO.File]::WriteAllText($settings, ([regex]'\{').Replace([IO.File]::ReadAllText($settings), "{`n$off,", 1))
}

# Point the extension and Claude Code at the test folder, only for the window started below.
# Also drop what a VS Code terminal sets, so the new window starts on its own instead of joining the one you are in.
$names = 'CHECKLIST_BRIDGE_HOME', 'CLAUDE_CONFIG_DIR', 'VSCODE_IPC_HOOK_CLI', 'ELECTRON_RUN_AS_NODE'
$saved = @{}
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  $env:VSCODE_IPC_HOOK_CLI = $null
  $env:ELECTRON_RUN_AS_NODE = $null
  $env:CHECKLIST_BRIDGE_HOME = Join-Path $Base 'home'
  $env:CLAUDE_CONFIG_DIR = Join-Path $Base 'claude'
  & $Editor "--extensionDevelopmentPath=$root" "--user-data-dir=$(Join-Path $Base 'vscode')" "--extensions-dir=$(Join-Path $Base 'exts')" $scratch
} finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
}

Write-Host ''
Write-Host 'A test window should open now. Its title ends with [Extension Development Host]: only that window runs this build.'
Write-Host '(Opening the cb-dev folder yourself runs your installed copy instead. If no window opens, run this script again.)'
Write-Host 'In View > Output > Checklist Bridge, the first line says where the running copy was loaded from: this folder.'
Write-Host ''
Write-Host 'In the test window: open the terminal, run `claude` (sign in the first time), then ask for a checklist.'
Write-Host 'Or, without Claude: Ctrl+Shift+P > Checklist Bridge: Open an example checklist.'
Write-Host ''
# What to check by hand: the same list for both scripts.
Write-Host (Get-Content -Raw (Join-Path $PSScriptRoot 'dev-checks.txt')).TrimEnd()
Write-Host ''
Write-Host "Everything it uses is in $Base. Delete that folder when you're done, or run this script with -Fresh."
