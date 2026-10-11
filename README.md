# Checklist Bridge for Claude Code

Each Claude chat gets its own checklist in VS Code for the things you have to do by hand. Claude adds tasks while you keep chatting. You tick a task, write a note or paste a screenshot, and press **Share**. Claude can read a task only after you share it.

## Setup

1. **Install** `checklist-bridge-0.2.0.vsix`: Extensions view → `…` → **Install from VSIX…**. If you installed v0.1, this replaces it.
2. **Connect Claude Code.** Click **Connect** on the pop-up, or run *Checklist Bridge: Connect Claude Code* from the command palette. A terminal opens with the command ready. Press Enter.
   It removes the old v0.1 setup and adds the new one, which looks like:
   ```
   claude mcp add --transport stdio --scope user checklist -- node ~/.checklist-bridge/connector/connector.js
   ```
3. **Start a new Claude chat.** Run `/mcp` to check that `checklist` is connected.

Claude learns how to use the checklist from the connector itself. To make sure it never writes manual steps into the chat instead, add this to `~/.claude/CLAUDE.md`:

```markdown
## Manual steps
Whenever I need to do something by hand, add it to my checklist with checklist_add_tasks instead of writing the
steps in your reply. While there are waiting tasks, call checklist_read at the start of each reply. Only trust
tasks I have shared.
```

To skip the permission prompt each time, add `"mcp__checklist"` to `permissions.allow` in `~/.claude/settings.json`.

## Using it

- **One checklist per chat.** Two agents in the same window get two separate checklists. Each one opens in the window where its chat is running.
- **Share tasks one at a time.** Tick the box, and optionally write a note or attach screenshots (paste, drag in, or **Attach screenshot**). Then press **Share as done**, or **Ctrl/Cmd+Enter** in the note. You can also share a task as *not done* with a note saying what went wrong.
- **Take back** un-shares a task so you can change it. Claude is told you took it back.
- Each task shows **Seen by Claude** once Claude has read it.
- **The next task** is pinned at the top and already open; urgent tasks jump ahead and turn it red. Everything else is a one-line row you can click to open. A dashed checkbox means you've started a task but not shared it.
- **The progress bar** counts only what Claude can see: green for shared as done, orange for shared as not done. Shared tasks collect in a **Shared with Claude** section at the bottom. Tick two or more tasks and a **Share all** bar appears.
- **Tags and groups** come from Claude, for example *urgent* (red) or *important* (amber). Claude can re-tag, regroup, rename or remove tasks at any time.
- **Hide and show.** Closing a checklist tab only hides it. The **Claude checklists** icon in the activity bar lists every checklist in the window with show/hide and close buttons, plus *Show all* and *Hide all*. If Claude adds tasks to a hidden checklist, you get a notification instead of a tab popping open.
- **Close** a checklist for good with **Close** in its header. Claude is told, and the next tasks it adds start a new checklist.
- Checklists survive a window reload.

## Updates

The extension updates itself from the public GitHub repo `Akshat270/checklist-bridge`. Shortly after VS Code starts, and every few hours after that, it reads `latest.json` on the main branch. If there's a newer version, it downloads the `.vsix`, checks its SHA-256, installs it, and offers **Reload window**. The Claude Code connector is refreshed on reload as well, so there's nothing to redo in Claude.

- *Checklist Bridge: Check for updates* runs a check right away.
- Settings: `checklistBridge.autoUpdate` turns updates off; `checklistBridge.updateRepo` points to a different repo.
- To publish: bump `version` in package.json, run `python3 scripts/release.py "what changed"`, then commit and push.

## How a chat finds its window

Claude Code starts a small connector for each chat. The connector picks a VS Code window in this order:

1. The window the chat was started from. The extension marks Claude Code chats and terminals in its window.
2. The window Claude Code's own VS Code integration is connected to.
3. The window that has the chat's project folder open.
4. The window you used most recently.

*Output → Checklist Bridge* shows every call.

## Building from source

```
npm install
npx tsc -p .
npx vsce package --no-dependencies
```
