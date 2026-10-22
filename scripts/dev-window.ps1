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
Write-Host 'Test window opened. In it: open the terminal, run `claude` (sign in the first time), then ask for a checklist.'
Write-Host ''
# What to check by hand. Keep it the same as the list in dev-window.sh.
Write-Host @'
What to try in this build. First ask Claude: "Make me a checklist with 4 tasks (mark one urgent),
a question with 3 options, and a task that needs a screenshot."

Keyboard (put the mouse away):
  1. Tab past a task's checkbox to its text and press Enter, then Space: it opens and shuts.
  2. Tab on to its id (t1) and press Enter: the id is copied, and the task stays as it was.
  3. Tab to the question's choices and use the arrow keys: the pick moves. With Ctrl, Alt or Shift held, it doesn't.
  4. Type in a task's note, and meanwhile ask Claude in the chat to reword that task: you can keep typing.
  5. Paste a screenshot into a note. Tab to it and press Enter: it shows full size, and Tab stays on it.
     Escape closes it and puts you back on the screenshot.
  6. Pick an answer and press Share answer: the focus stays on the question card, never on Send now.
  7. Tick two tasks, Tab to Share all at the bottom and press Enter: the focus moves to the next task.

Screen reader (if you have one: Narrator, VoiceOver or Orca):
  8. A closed urgent task says "Urgent". A shared task says how it was shared,
     and whether Claude has read it.

Look:
  9. Pick a High Contrast Light theme (Ctrl+K Ctrl+T, or Cmd+K Cmd+T on a Mac): tags and marks
     are dark and easy to read.
 10. While Claude waits for you, the "Claude is waiting" banner has only an outline:
     the next task is the one tinted thing.

Away mode:
 11. Click the moon icon, pick 30 min and press Yes. Claude doesn't wait for you: it does the safe work,
     adds what it skipped to the checklist, then stops with a summary.
 12. Press I'm back. Nothing is sent to Claude. Use Send now or write to it to carry on.
 13. Click the moon again, type a time 1 minute from now under "Or at" and press Set. Wait 2 minutes, then press Yes:
     the panel says the time has passed and asks again.

Closing:
 14. Pick an answer but don't share it, then close the checklist with the X:
     the warning says "1 answer is still not shared".
'@
Write-Host ''
Write-Host "Everything it uses is in $Base. Delete that folder when you're done, or run this script with -Fresh."
