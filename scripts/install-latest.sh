#!/usr/bin/env sh
# Installs the newest Checklist Bridge build from GitHub into VS Code (macOS / Linux).
# Run:
#   curl -fsSL https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/scripts/install-latest.sh | sh
set -eu
REPO=${CHECKLIST_BRIDGE_REPO_URL:-https://raw.githubusercontent.com/Akshat270/checklist-bridge/main}

JSON=$(curl -fsSL "$REPO/latest.json?t=$(date +%s)")
field() { printf '%s' "$JSON" | sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p"; }
VERSION=$(field version); VSIX=$(field vsix); SHA=$(field sha256)

FILE="${TMPDIR:-/tmp}/checklist-bridge-$VERSION.vsix"
echo "Downloading Checklist Bridge $VERSION..."
curl -fsSL "$REPO/$VSIX" -o "$FILE"

GOT=$( (sha256sum "$FILE" 2>/dev/null || shasum -a 256 "$FILE") | cut -d' ' -f1)
[ "$GOT" = "$SHA" ] || { echo "Download is corrupted (checksum mismatch). Try again in a minute." >&2; exit 1; }

CODE=$(command -v code || command -v code-insiders || true)
[ -n "$CODE" ] || { echo "The 'code' command isn't on your PATH. In VS Code, run 'Shell Command: Install code command in PATH'." >&2; exit 1; }

"$CODE" --install-extension "$FILE" --force
rm -f "$FILE"
echo
echo "Installed Checklist Bridge $VERSION. In VS Code, run 'Developer: Reload Window' to use it."
