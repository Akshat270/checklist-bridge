# Installs the newest Checklist Bridge build from GitHub into VS Code (Windows).
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/scripts/install-latest.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = if ($env:CHECKLIST_BRIDGE_REPO_URL) { $env:CHECKLIST_BRIDGE_REPO_URL } else { 'https://raw.githubusercontent.com/Akshat270/checklist-bridge/main' }

$latest = Invoke-RestMethod "$repo/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$file = Join-Path $env:TEMP "checklist-bridge-$($latest.version).vsix"
Write-Host "Downloading Checklist Bridge $($latest.version)..."
Invoke-WebRequest "$repo/$($latest.vsix)" -OutFile $file -UseBasicParsing

$hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $latest.sha256) { throw "Download is corrupted (checksum mismatch). Try again in a minute." }

$code = Get-Command code -ErrorAction SilentlyContinue
if (-not $code) { $code = Get-Command code-insiders -ErrorAction SilentlyContinue }
if (-not $code) { throw "The 'code' command isn't on your PATH. In VS Code, run 'Shell Command: Install code command in PATH', or reinstall VS Code with 'Add to PATH' ticked." }

& $code.Source --install-extension $file --force
Remove-Item $file -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Installed Checklist Bridge $($latest.version). In VS Code, run 'Developer: Reload Window' to use it." -ForegroundColor Green
