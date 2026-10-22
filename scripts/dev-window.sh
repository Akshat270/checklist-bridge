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

echo "Built commit: $(git -C "$root" log -1 --format='%h %s' 2>/dev/null || echo unknown)"
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
echo "A test window should open now. Its title ends with [Extension Development Host]: only that window runs this build."
echo "(Opening the cb-dev folder yourself runs your installed copy instead. If no window opens, run this script again.)"
echo "In View > Output > Checklist Bridge, the first line says where the running copy was loaded from: this folder."
echo
echo "In the test window: open the terminal, run 'claude' (sign in the first time), then ask for a checklist."
echo "Or, without Claude: Ctrl+Shift+P (Cmd+Shift+P on a Mac) > Checklist Bridge: Open an example checklist."
echo
# What to check by hand. Keep it the same as the list in dev-window.ps1.
cat <<'CHECKS'
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
CHECKS
echo
echo "Everything it uses is in $base. Delete that folder when you're done, or run this script with --fresh."
