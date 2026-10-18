# Checklist Bridge for Claude Code

When Claude Code needs you to do something by hand, like create an API key, run a command, click through a dashboard or test a page, it usually buries the steps in the chat. Checklist Bridge gives each Claude chat its own checklist in VS Code instead.

Claude adds tasks while you keep talking. You tick them off, write a note or paste a screenshot, and press **Share** when a task is ready. Claude can read only the tasks you've shared, so it never assumes you did something you haven't.

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-dark.png" width="360" alt="A checklist in VS Code: an urgent task pinned at the top, grouped tasks below, and a progress bar showing 3 of 8 tasks shared with Claude">
  &nbsp;
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-light.png" width="360" alt="The same checklist in a light VS Code theme">
</p>

## Install

1. **Install it from the VS Code Marketplace.** In VS Code, open the Extensions view, search for **Checklist Bridge** and click **Install**. Or [open the Marketplace page](https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge), or run:
   ```
   code --install-extension Akshat270.checklist-bridge
   ```
   <sub>No Marketplace access (for example in Cursor or VSCodium)? [Download the `.vsix`](https://github.com/Akshat270/checklist-bridge/raw/main/releases/checklist-bridge-latest.vsix), then in the Extensions view click `…` → **Install from VSIX…** and pick the file.</sub>
2. That's it: the extension connects itself to Claude Code the first time VS Code starts, and tells you when it's done. There's no command to type.
3. Start a **new** Claude chat (Claude Code loads tools when a chat starts). Run `/mcp` to check that `checklist` is connected.

If Claude Code isn't installed yet, the extension says so: install it, then click **Connect Claude Code** in the **Claude checklists** sidebar. *Checklist Bridge: Getting started* walks through every step, and *Open an example checklist* lets you try the panel without Claude.

**Requirements:** VS Code 1.85 or newer, and [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), either in the terminal or the VS Code extension. Node.js is used if you have it; otherwise VS Code's built-in runtime runs the connector. Works on macOS, Windows and Linux.

### Make every Claude chat use it automatically

After you connect, the extension offers to set this up for you. You can also run *Checklist Bridge: Make every Claude Code chat use checklists* any time. It makes two small changes that every Claude Code session on your computer picks up:

- A short instruction in `~/.claude/CLAUDE.md`, inside clearly marked comments, telling Claude to put manual steps on your checklist and to read what you've shared.
- `"mcp__checklist"` in `permissions.allow` in `~/.claude/settings.json`, so Claude doesn't ask before each checklist call. The original file is backed up first, and a settings file with comments is never rewritten.

*Checklist Bridge: Undo Claude Code setup* removes both again.

<details><summary>Prefer to do it by hand?</summary>

Add this to `~/.claude/CLAUDE.md`:

```markdown
## Manual steps (Checklist Bridge)
Whenever I need to do something by hand, like create an account or API key, run a command, change a setting, click
through a dashboard, test something or tell you a value, add it to my checklist with the checklist_add_tasks tool
instead of writing the steps in your reply. While this chat's checklist has waiting tasks, call checklist_read at
the start of each reply. Only trust tasks I have shared. If the checklist tools aren't available, give the steps in
your reply as usual.
```

Then add `"mcp__checklist"` to `permissions.allow` in `~/.claude/settings.json`.
</details>

## Questions you can answer later

When Claude needs a decision that doesn't have to happen right now, like which payment gateway to use, how to name a page, or what the free plan includes, it asks it in the checklist instead of listing options in the chat. Claude keeps working on everything else while you think.

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-decide.png" width="360" alt="The Decide section: an urgent question about payment gateways with Claude's pick highlighted, a second open question, and an answered question with a Send now button">
</p>

- Questions sit in their own **Decide** section at the top, with the options, short summaries, **Details** you can expand, and Claude's pick with its reason. Urgent questions turn red.
- Pick an option (or several, if Claude allows it), or choose **Something else** and type your own answer. Add a note or screenshots if you like, then press **Share answer**.
- Claude sees your answer the next time it reads the checklist. To hand it over straight away, press **Send now**.

### How "Send now" reaches Claude

| Where Claude is running | What Send now does |
|---|---|
| Claude is **waiting** on the checklist (it does this when only your input is left) | Nothing to do: your answer reaches it the moment you share it. The panel shows *Claude is waiting for you*. |
| In a **VS Code terminal** | Types a one-line update into that terminal and presses Enter, only while Claude is still running there. |
| Started with **channels** (*Checklist Bridge: Start Claude with Send now*) | Pushes the update into the chat, even while Claude is idle. Channels are a [Claude Code research preview](https://code.claude.com/docs/en/channels), so Claude asks you to confirm when it starts. |
| Idle in the **Claude panel** | Claude can't be woken from outside, so the button becomes **Copy for chat**: it copies a one-line update for you to paste. |

Send now works for shared tasks too.

## How it works

- **One checklist per chat.** Each chat's checklist opens in the VS Code window where that chat is running. Two agents in the same window get two separate checklists.
- **The next task comes first.** It's pinned at the top and already open. Urgent tasks jump ahead and turn it red. Everything else is a one-line row you can click to open.
- **Share tasks one at a time.** Tick a task, optionally add a note or screenshots (paste, drag in, or click the picture icon in the note box), and press **Share**. Tick several and **Share all**. You can also share a task as *not done*, with a note saying what went wrong.
- **Claude only sees what you share.** The progress bar counts shared tasks only. Shared tasks move to **Shared with Claude**, which shows whether Claude has read each one. **Take back** hides a task from Claude again so you can change it.
- **Every item has an id.** The small label at the right edge of each task and question (t1, q2…) is the name Claude uses for it. Click it to copy it, then paste it into the chat.
- **Claude can organise the list.** It can tag tasks (*urgent*, *important*, *quick*, *optional*, *blocked*), group them, reword them and remove ones that are no longer needed. Tags decide the order of tasks that can be done in any order. When steps must be done one after another, Claude puts them in an ordered group: they show as numbered steps in its order, and tags never move them. It can reorder the steps later if the plan changes. For a roadmap with stages (set up, then testing, then wrap up), Claude can also put the groups themselves in order: they show as Phase 1 of 3, Phase 2 of 3 and so on, and the steps are numbered across all of them.
- **Hide or close.** Closing a tab only hides that checklist. The **Claude checklists** icon in the activity bar lists every checklist with show, hide and close. Click one in the list to open it and bring it to the front. Closing a checklist for good tells Claude, and the next tasks it adds start a new checklist.
- **Nothing is lost on reload.** Checklists survive a window reload.

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-shared.png" width="360" alt="Several ticked tasks with a Share all bar at the bottom, and the Shared with Claude section showing which tasks Claude has read">
</p>

Claude gets five tools:

| Tool | What it does |
|---|---|
| `checklist_add_tasks` | Adds tasks (with optional details, a command to copy, tags and a group) and opens the checklist. It doesn't wait; you work at your own pace. |
| `checklist_ask` | Asks you a question in the Decide section, with options, details and Claude's recommendation. It doesn't wait. |
| `checklist_read` | Returns only what you shared: tasks done or not done, your answers, your notes, and your screenshots as images. Everything else shows as "waiting". |
| `checklist_wait` | Waits until you share something, then returns it. Claude uses this only when your input is the only thing left. |
| `checklist_edit` | Renames the checklist, rewords tasks, changes tags and groups, updates or withdraws questions, or removes tasks. |

## Privacy

Everything stays on your computer. Checklists, notes and screenshots are stored in VS Code's own storage for the workspace. Claude Code talks to the extension over `127.0.0.1` only, with a random token. Screenshots reach Claude only when you share the task they're attached to.

The one network request the extension makes is the update check described below. You can switch it off.

## Updates

If you installed from the Marketplace, VS Code updates it like any other extension. The extension also keeps itself up to date from this repo, which covers `.vsix` installs too. Shortly after VS Code starts, and every few hours after that, it reads [`latest.json`](latest.json). If there's a newer version, it downloads the `.vsix`, checks its SHA-256, installs it, and offers **Reload window**. Claude's connection is refreshed on reload too, so there's nothing to redo.

- *Checklist Bridge: Check for updates* runs a check right away.
- `checklistBridge.autoUpdate` turns updates off.

## Troubleshooting

- **It says it couldn't find Claude Code.** If Claude Code is installed somewhere unusual, set `checklistBridge.claudePath` to the full path of the `claude` command and run *Checklist Bridge: Connect Claude Code*. The warning also offers **Try in a terminal**, which runs the setup in a VS Code terminal, whose shell often finds `claude` when VS Code can't.
- **`/mcp` shows `checklist` as failed.** Run *Checklist Bridge: Connect Claude Code* again and start a new chat. If you have no Node.js, the connection uses VS Code's own runtime; make sure VS Code is installed in its usual place.
- **You'd rather connect by hand.** Set `checklistBridge.autoConnect` to `false`, run *Checklist Bridge: Copy Claude Code setup command*, and paste it into a terminal. *Checklist Bridge: Disconnect Claude Code* removes the connection, and it stays removed until you click **Connect** again.

Settings that decide where updates come from or which program runs (`updateRepo`, `autoUpdate`, `autoConnect`, `claudePath`) are only read from your user settings, never from a project's `.vscode/settings.json`.
- **Claude says no VS Code window is running.** Open VS Code with the extension installed, then ask Claude to try again.
- **The checklist opened in the wrong window.** See *Output → Checklist Bridge* for which window each chat picked and why. The connector picks a window in this order:
  1. The window the chat was started from.
  2. The window Claude Code's own VS Code integration is connected to.
  3. The window that has the chat's project folder open.
  4. The window you used most recently.
- **Claude doesn't notice what you shared.** Claude reads the checklist when it replies. Send any message, even "done".

## Installing the newest build from GitHub

To install the latest release straight from GitHub (useful in Cursor or VSCodium, or to test a build before it reaches the Marketplace), run one line, then reload VS Code:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/scripts/install-latest.ps1 | iex
```
```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/scripts/install-latest.sh | sh
```

It checks the download against the published SHA-256 before installing.

## Building from source

```
npm install
npm run build            # compiles src/ to dist/
python3 scripts/release.py "what changed"   # packages releases/*.vsix and updates latest.json
```

Pushing a new `latest.json` to `main` publishes that `.vsix` to the Marketplace through `.github/workflows/publish.yml`, using the `VSCE_PAT` repository secret.

Without `npm install`, you can build against the bundled type stub with `npx tsc -p tsconfig.offline.json`.

### Tests

```
npm test                 # all suites
node test/run.js reload  # just one (by file name prefix)
```

The suites in `test/` run the compiled extension inside a stand-in VS Code window (`test/harness/fakewin.js`) and talk to it through the real connector, the way Claude Code does: tasks, questions, Send now, window routing, reloads, saving, updates and the Claude Code setup. The panel tests render the real webview in Chromium and need Playwright (`npx playwright install chromium`); they're skipped without it. GitHub runs everything on each push.

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

---

Made by [Akshat](https://github.com/Akshat270) while building [Unilytic](https://unilytic.in), analytics for Amazon sellers in India. Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic. MIT licensed.
