#!/usr/bin/env bash
# Opens a separate test copy of VS Code with this checkout of Checklist Bridge loaded (macOS and Linux).
# Your installed VS Code, your installed copy of the extension, ~/.checklist-bridge and ~/.claude are not touched.
# Everything the test window needs lives in one folder (default: ~/cb-dev), including its own Claude Code settings.
#
#   ./scripts/dev-window.sh               open the test window
#   ./scripts/dev-window.sh --fresh       start again from nothing (deletes the cb-dev folder)
#   ./scripts/dev-window.sh --skip-build  you already ran npm run build
#   CODE=/path/to/code ./scripts/dev-window.sh   use a different editor command (not checked)
#   CB_DEV=/some/cb-dev ./scripts/dev-window.sh  use a different test folder (its name must be cb-dev)
set -euo pipefail

fresh=0
build=1
for arg in "$@"; do
  case "$arg" in
    --fresh) fresh=1 ;;
    --skip-build) build=0 ;;
    *) echo "Unknown option: $arg. Use --fresh and/or --skip-build." >&2; exit 1 ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
base="${CB_DEV:-$HOME/cb-dev}"
case "$base" in /*) ;; *) base="$PWD/$base" ;; esac # relative means relative to where you ran this from
code="${CODE:-code}"

command -v "$code" >/dev/null 2>&1 || { echo "Could not find '$code'. Install VS Code's shell command, or set CODE=/path/to/code." >&2; exit 1; }
if [ -z "${CODE:-}" ] && ! "$code" --help 2>/dev/null | head -n 1 | grep -q "Visual Studio Code"; then
  echo "'code' does not look like VS Code (it may be Cursor, VSCodium or another editor). Set CODE=/path/to/code to use it anyway." >&2
  exit 1
fi

if [ "$fresh" = 1 ] && [ -d "$base" ]; then
  [ "$(basename "$base")" = "cb-dev" ] || { echo "--fresh only deletes a folder named cb-dev. Not deleting $base." >&2; exit 1; }
  rm -rf "$base"
fi

cd "$root"
if [ "$build" = 1 ]; then
  [ -d node_modules ] || npm ci
  npm run build
fi

mkdir -p "$base/scratch" "$base/vscode/User"
# Keep the test window from replacing the test build with the released version: turn autoUpdate off unless the
# test profile already says something about it.
node -e '
const fs = require("fs"), f = process.argv[1];
const off = "  \"checklistBridge.autoUpdate\": false";
const t = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
if (!t.trim()) fs.writeFileSync(f, "{\n" + off + "\n}\n");
else if (!/checklistBridge\.autoUpdate/.test(t)) fs.writeFileSync(f, t.replace("{", "{\n" + off + ","));
' "$base/vscode/User/settings.json"

# Also drop what a VS Code terminal sets, so the new window starts on its own instead of joining the one you are in.
env -u VSCODE_IPC_HOOK_CLI -u ELECTRON_RUN_AS_NODE \
  CHECKLIST_BRIDGE_HOME="$base/home" CLAUDE_CONFIG_DIR="$base/claude" \
  "$code" --extensionDevelopmentPath="$root" --user-data-dir="$base/vscode" --extensions-dir="$base/exts" "$base/scratch"

echo
echo "Test window opened. In it: open the terminal, run 'claude' (sign in the first time), then ask for a checklist."
echo "Everything it uses is in $base. Delete that folder when you're done, or run this script with --fresh."
