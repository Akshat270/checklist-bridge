#!/usr/bin/env bash
# Opens a separate test copy of VS Code with this checkout of Checklist Bridge loaded (macOS and Linux).
# Your installed VS Code, your installed copy of the extension, ~/.checklist-bridge and ~/.claude are not touched.
# Everything the test window needs lives in one folder (default: ~/cb-dev), including its own Claude Code settings.
#
#   ./scripts/dev-window.sh            open the test window
#   ./scripts/dev-window.sh --fresh    start again from nothing (deletes the cb-dev folder)
#   CODE=/path/to/code ./scripts/dev-window.sh   use a different editor command
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
base="${CB_DEV:-$HOME/cb-dev}"
code="${CODE:-code}"

command -v "$code" >/dev/null 2>&1 || { echo "Could not find '$code'. Install VS Code's shell command, or set CODE=/path/to/code." >&2; exit 1; }

if [ "${1:-}" = "--fresh" ] && [ -d "$base" ]; then
  [ "$(basename "$base")" = "cb-dev" ] || { echo "--fresh only deletes a folder named cb-dev. Not deleting $base." >&2; exit 1; }
  rm -rf "$base"
fi

cd "$root"
[ -d node_modules ] || npm ci
npm run build

mkdir -p "$base/scratch" "$base/vscode/User"
# Keep the test window from replacing the test build with the released version.
[ -f "$base/vscode/User/settings.json" ] || printf '{\n  "checklistBridge.autoUpdate": false\n}\n' > "$base/vscode/User/settings.json"

CHECKLIST_BRIDGE_HOME="$base/home" CLAUDE_CONFIG_DIR="$base/claude" \
  "$code" --extensionDevelopmentPath="$root" --user-data-dir="$base/vscode" --extensions-dir="$base/exts" "$base/scratch"

echo
echo "Test window opened. In it: open the terminal, run 'claude' (sign in the first time), then ask for a checklist."
echo "Everything it uses is in $base. Delete that folder when you're done, or run this script with --fresh."
