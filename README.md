# Checklist Bridge for Claude Code

When Claude Code needs you to do something by hand, like create an API key, run a command, click through a dashboard or test a page, it usually buries the steps in the chat. Checklist Bridge gives each Claude chat its own checklist in VS Code instead.

Claude adds tasks while you keep talking. You tick them off, write a note or paste a screenshot, and press **Share** when a task is ready. Claude can read only the tasks you've shared, so it never assumes you did something you haven't.

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-dark.png" width="360" alt="A checklist in VS Code: an urgent task pinned at the top, grouped tasks below, and a progress bar showing 3 of 8 tasks shared with Claude">
  &nbsp;
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-light.png" width="360" alt="The same checklist in a light VS Code theme">
</p>

## Install

1. **[Download the extension](https://github.com/Akshat270/checklist-bridge/raw/main/releases/checklist-bridge-latest.vsix)** (`.vsix`).
2. In VS Code, open the Extensions view, click `…` → **Install from VSIX…** and pick the file. Or run:
   ```
   code --install-extension checklist-bridge-latest.vsix
   ```
3. Click **Connect** when VS Code asks, or run *Checklist Bridge: Connect Claude Code* from the command palette. A terminal opens with the command ready; press Enter.
4. Start a new Claude chat. Run `/mcp` to check that `checklist` is connected.

That's it. To try the panel without Claude, run *Checklist Bridge: Open an example checklist*.

**Requirements:** VS Code 1.85 or newer, and [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), either in the terminal or the VS Code extension. Node.js is used if you have it; otherwise VS Code's built-in runtime runs the connector. Works on macOS, Windows and Linux.

### Recommended: tell Claude to always use it

Claude learns about the checklist from the connector itself. To make sure it never writes manual steps into the chat instead, add this to `~/.claude/CLAUDE.md`:

```markdown
## Manual steps
Whenever I need to do something by hand, add it to my checklist with checklist_add_tasks instead of writing the
steps in your reply. While there are waiting tasks, call checklist_read at the start of each reply. Only trust
tasks I have shared.
```

To skip the permission prompt each time, add `"mcp__checklist"` to `permissions.allow` in `~/.claude/settings.json`.

## How it works

- **One checklist per chat.** Each chat's checklist opens in the VS Code window where that chat is running. Two agents in the same window get two separate checklists.
- **The next task comes first.** It's pinned at the top and already open. Urgent tasks jump ahead and turn it red. Everything else is a one-line row you can click to open.
- **Share tasks one at a time.** Tick a task, optionally add a note or screenshots (paste, drag in, or **Add image**), and press **Share**. Tick several and **Share all**. You can also share a task as *not done*, with a note saying what went wrong.
- **Claude only sees what you share.** The progress bar counts shared tasks only. Shared tasks move to **Shared with Claude**, which shows whether Claude has read each one. **Take back** hides a task from Claude again so you can change it.
- **Claude can organise the list.** It can tag tasks (*urgent*, *important*, *quick*, *optional*, *blocked*), group them, reword them and remove ones that are no longer needed.
- **Hide or close.** Closing a tab only hides that checklist. The **Claude checklists** icon in the activity bar lists every checklist with show, hide and close. Closing a checklist for good tells Claude, and the next tasks it adds start a new checklist.
- **Nothing is lost on reload.** Checklists survive a window reload.

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-shared.png" width="360" alt="Several ticked tasks with a Share all bar at the bottom, and the Shared with Claude section showing which tasks Claude has read">
</p>

Claude gets three tools:

| Tool | What it does |
|---|---|
| `checklist_add_tasks` | Adds tasks (with optional details, a command to copy, tags and a group) and opens the checklist. It doesn't wait; you work at your own pace. |
| `checklist_read` | Returns only the tasks you shared: done or not done, your notes, and your screenshots as images. Unshared tasks show as "waiting". |
| `checklist_edit` | Renames the checklist, rewords tasks, changes tags and groups, or removes tasks. |

## Privacy

Everything stays on your computer. Checklists, notes and screenshots are stored in VS Code's own storage for the workspace. Claude Code talks to the extension over `127.0.0.1` only, with a random token. Screenshots reach Claude only when you share the task they're attached to.

The one network request the extension makes is the update check described below. You can switch it off.

## Updates

The extension keeps itself up to date from this repo. Shortly after VS Code starts, and every few hours after that, it reads [`latest.json`](latest.json). If there's a newer version, it downloads the `.vsix`, checks its SHA-256, installs it, and offers **Reload window**. Claude's connection is refreshed on reload too, so there's nothing to redo.

- *Checklist Bridge: Check for updates* runs a check right away.
- `checklistBridge.autoUpdate` turns updates off.

## Troubleshooting

- **`/mcp` shows `checklist` as failed.** Run *Checklist Bridge: Connect Claude Code* again and start a new chat. If you have no Node.js, the command uses VS Code's runtime; make sure VS Code is installed in its usual place.
- **Claude says no VS Code window is running.** Open VS Code with the extension installed, then ask Claude to try again.
- **The checklist opened in the wrong window.** See *Output → Checklist Bridge* for which window each chat picked and why. The connector picks a window in this order:
  1. The window the chat was started from.
  2. The window Claude Code's own VS Code integration is connected to.
  3. The window that has the chat's project folder open.
  4. The window you used most recently.
- **Claude doesn't notice what you shared.** Claude reads the checklist when it replies. Send any message, even "done".

## Building from source

```
npm install
npm run build            # compiles src/ to dist/
python3 scripts/release.py "what changed"   # packages releases/*.vsix and updates latest.json
```

Without `npm install`, you can build against the bundled type stub with `npx tsc -p tsconfig.offline.json`.

Issues and pull requests are welcome.

---

Made by [Akshat](https://github.com/Akshat270). Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic. MIT licensed.
