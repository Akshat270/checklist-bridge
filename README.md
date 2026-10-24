<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/hero.png" alt="Checklist Bridge for Claude Code: every Claude chat gets its own checklist in VS Code" width="100%">
</p>

<h1 align="center">Checklist Bridge for Claude Code</h1>

<p align="center"><b>Give every Claude Code chat its own checklist in VS Code.</b><br>
The things only you can do, and the decisions you can make later, no longer get lost in the chat.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge"><img alt="Version" src="https://img.shields.io/visual-studio-marketplace/v/Akshat270.checklist-bridge?label=Marketplace&color=5b5bd6"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge"><img alt="Installs" src="https://img.shields.io/visual-studio-marketplace/i/Akshat270.checklist-bridge?color=2ea043"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge&ssr=false#review-details"><img alt="Rating" src="https://img.shields.io/visual-studio-marketplace/r/Akshat270.checklist-bridge?color=cca700"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="macOS, Windows and Linux" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-supported-lightgrey">
</p>

When Claude Code needs you to do something by hand, like create an API key, run a command, click through a dashboard or test a page, it usually buries the steps in a long chat. Checklist Bridge puts them in a checklist next to the chat instead. Claude adds tasks while you keep talking. You tick them off, write a note or paste a screenshot, and press **Share** when a task is ready. Claude can read only the tasks you've shared, so it never assumes you did something you haven't.

<p align="center">
  <a href="https://github.com/Akshat270/checklist-bridge/blob/main/promo/video/output/checklist-bridge-promo-square.mp4"><img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/video-preview.gif" width="480" alt="Checklist Bridge in action: Claude adds an urgent task, you tick it, write a note, paste a screenshot and press Share, and Claude reads it"></a><br>
  <b>▶ <a href="https://github.com/Akshat270/checklist-bridge/blob/main/promo/video/output/checklist-bridge-promo-square.mp4">Watch the 44-second video</a></b> (with sound) · <a href="https://github.com/Akshat270/checklist-bridge/blob/main/promo/video/output/checklist-bridge-promo-vertical.mp4">vertical version</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-dark.png" width="300" alt="A checklist in VS Code: an urgent task pinned at the top, grouped tasks below, and a progress bar">
  &nbsp;
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-steps.png" width="300" alt="A roadmap in three phases with numbered steps; the next step is open and shows a command to copy">
  &nbsp;
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-decide.png" width="300" alt="The Decide section: an urgent question about payment gateways with Claude's pick highlighted">
</p>

## Why people install it

- **Never scroll the chat for "what do I need to do?"** The next task is open and highlighted. Urgent ones turn red.
- **Keep Claude working while you think.** Questions that don't need an answer right now go to a **Decide** section. Claude carries on with everything else.
- **Step away without stalling Claude.** Tell it when you'll be back. It stops waiting for your answers, does what it safely can, and leaves the rest for you. [How it works](#when-youre-away).
- **Claude never assumes.** It sees only what you've shared: done, not done, your note, your screenshots. Nothing else is guessed.
- **One checklist per chat.** Running several agents? Each has its own list, in the window it runs in.
- **Nothing to set up.** Install it and it connects itself to Claude Code. No config files, no commands.
- **Private.** Everything stays on your computer. [More on privacy](#privacy).

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/how-it-works.png" width="100%" alt="Four steps: Claude adds the tasks, you work at your own pace, you press Share, Claude reads what you shared">
</p>

## What you get

| | |
|---|---|
| **Tasks with context** | Details on where to click, plus a one-click **Copy** for commands and values. Tag tasks *urgent*, *important*, *quick*, *optional* or *blocked*. |
| **Questions for later** | Options with short summaries, expandable **Details**, and Claude's pick with its reason. Pick one, pick several, or write your own answer. |
| **Steps and roadmaps** | When things must happen in order, they show as numbered steps. Big jobs become phases (*Set up, Test, Go live*) and only the next step is open. |
| **Notes and screenshots** | Paste, drag in or click the picture icon. Screenshots reach Claude only with the task they belong to. |
| **Share on your terms** | Share one task, **Share all**, share as *not done* with a note, or **Take back** before Claude reads it. |
| **Send now** | Hand an answer to Claude straight away, in the terminal or the Claude panel. [How it reaches Claude](#how-send-now-reaches-claude). |
| **Away mode** | Leaving for a while? Say when you'll be back and Claude stops waiting for you. It does what it safely can and tells you what's left. [How it works](#when-youre-away). |
| **Every chat, automatically** | One optional step makes every Claude Code chat use checklists. [Set it up](#make-every-claude-chat-use-it-automatically). |
| **Light and dark** | Follows your VS Code theme. Built for a narrow column next to the chat. |
| **Safe by design** | Checklists survive window reloads. Updates are checked against a SHA-256. A project can't redirect updates or run programs. |

<p align="center">
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-light.png" width="300" alt="The same checklist in a light VS Code theme">
  &nbsp;
  <img src="https://raw.githubusercontent.com/Akshat270/checklist-bridge/main/docs/checklist-shared.png" width="300" alt="Several ticked tasks with a Share all bar at the bottom, and the Shared with Claude section showing which tasks Claude has read">
</p>

## Good for

- Setting up accounts, API keys, environment variables and dashboards that Claude can't reach.
- Deploys and launches, where steps must happen in order and some need a quick check from you.
- Manual testing: Claude lists what to try, you report what happened, with screenshots.
- Product and design choices you want to think about while the code keeps moving.
- Anyone running several Claude agents at once and losing track of what each one is waiting on.

## Install

1. **Install it from the VS Code Marketplace.** In VS Code, open the Extensions view, search for **Checklist Bridge** and click **Install**. Or [open the Marketplace page](https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge), or run:
   ```
   code --install-extension Akshat270.checklist-bridge
   ```
   <sub>No Marketplace access (for example in Cursor or VSCodium)? [Download the `.vsix`](https://github.com/Akshat270/checklist-bridge/raw/main/releases/checklist-bridge-0.7.2.vsix), then in the Extensions view click `…` → **Install from VSIX…** and pick the file.</sub>
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

## Use it without VS Code

Checklist Bridge also comes as a **mod for Claude Code**: the same checklist runs inside Claude Code, as a pane next to the chat. You don't need VS Code for it. It works in the terminal, the Claude desktop app and the VS Code Claude panel.

**Install it.** Type this in Claude Code:

```
/plugin install checklist-bridge --marketplace Akshat270/checklist-bridge
```

Answer `y` to add the marketplace, pick a scope, then start a new chat. From a shell, `claude plugin install checklist-bridge --marketplace Akshat270/checklist-bridge` does the same. In the desktop app, click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Akshat270/checklist-bridge`, then **Add plugin**.

**Use it.** When Claude adds tasks or asks a question, the checklist opens next to the chat. You can also type `/checklist` to open it.

- The next task is open at the top of **To do**. Add a note if you like, then press **Done, share with Claude** (or **Couldn't do it, share note**). Press any other task to open it instead.
- For a question, pick an option (or type *Something else*), then press **Answer**.
- **Screenshots:** take one to the clipboard (Win+Shift+S on Windows, Cmd+Ctrl+Shift+4 on a Mac), then press **Paste screenshot** on the task. You can also type an image file's path. On Linux, pasting needs `wl-clipboard` or `xclip`.
- What you shared folds into **Shared with Claude** at the bottom. Open it to see what Claude has read, or to take something back.
- With the checklist focused (Ctrl+X, then Tab), keys work too: `d` done, `n` couldn't do it, `v` paste screenshot, `c` copy the task's command, `a` away, `b` I'm back, `1`–`9` pick an option, `s` send now. The keys are listed at the bottom of the checklist.
- **Light terminal?** Type `/config` in Claude Code and set Checklist Bridge's **Colors** to `light`.
- **Send now** hands what you shared to Claude as a message. If Claude is busy, it gets the message as soon as it finishes.
- **Going away?** Press **☾ Away** at the top of the checklist and pick 30 min, 1 h, 2 h or 4 h, or type `/checklist away 18:30` (also `45m`, `6:30pm`). Claude stops waiting for you: it does what it safely can and leaves the rest on the checklist. The checklist counts down the time left; press **+30 min** if you're running late, or **I'm back** to end it early. It also ends by itself.
- `/checklist list` shows earlier checklists in this folder, and `/checklist continue 2` makes one of them this chat's checklist.
- On the phone app you can tick and share, but not type notes.

Mods are new in Claude Code, so you need a recent version.

### Switching between the extension and the mod

Use one or the other, not both. When you switch, your open checklists for that folder come with you.

- **From VS Code to the mod:** run *Checklist Bridge: Use the Claude Code mod instead*. VS Code hands your checklists over and stops connecting Claude to the extension. Then install the mod as above and start a new chat.
- **From the mod to VS Code:** type `/checklist use-extension` in Claude Code, then open the folder in VS Code. The extension takes your checklists back and connects Claude again. You can also run *Checklist Bridge: Use this extension instead of the Claude Code mod* in VS Code.
- `/checklist use-mod` switches back to the mod from Claude Code.

While your checklists are in the mod, VS Code shows them read-only, with a **Switch back to VS Code** button at the top, so nothing done in two places at once can be lost. The mod works per folder, so a VS Code window with no folder open keeps its checklists. A checklist that moved over keeps its tasks, notes, answers and screenshots. Claude starts a new checklist in a new chat. Use `/checklist continue` in the mod to pick up an older one there.

## Questions you can answer later

When Claude needs a decision that doesn't have to happen right now, like which payment gateway to use, how to name a page, or what the free plan includes, it asks it in the checklist instead of listing options in the chat. Claude keeps working on everything else while you think.

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

## When you're away

If you leave Claude working and it would wait for your answers, tell it you'll be away.

1. Click the moon icon at the top of the checklist.
2. Pick **30 min**, **1 hour**, **2 hours** or **4 hours**, or type the time you'll be back and press **Set**.
3. Check the time it shows and press **Yes**. Press **Not now** if you changed your mind.

While you're away, Claude does not wait for you. It does the work that needs nothing from you and that it can finish safely. It skips anything that depends on a task or question you haven't answered, and anything risky or hard to undo. It adds what it skipped to the checklist, then stops with a short summary.

While you're away, the card shows the time left with a bar that shrinks. Press **+30 min** if you're running late, **Change** to pick another time, or **I'm back** to end it early. It also ends by itself at the time you gave. Claude is not woken up when it ends, so you aren't charged for waking a chat that has gone idle. To pick up where you left off, press **Send now** or write to Claude as usual. This is set for one chat at a time.

## The checklist in detail

- **One checklist per chat.** Each chat's checklist opens in the VS Code window where that chat is running. Two agents in the same window get two separate checklists.
- **The next task stands out.** It's already open and highlighted, in its place: first among the tasks without a group, or inside its own group. An urgent task becomes the next task and turns it red. If the next task is in a group you collapsed, the group opens; after you share a task, the panel scrolls to the next one. Everything else is a one-line row you can click to open.
- **Share tasks one at a time.** Tick a task, optionally add a note or screenshots (paste, drag in, or click the picture icon in the note box), and press **Share**. Tick several and **Share all**. You can also share a task as *not done*, with a note saying what went wrong.
- **Claude only sees what you share.** The progress bar counts shared tasks only. Shared tasks move to **Shared with Claude**, which shows whether Claude has read each one. **Take back** hides a task from Claude again so you can change it.
- **Every item has an id.** The small label at the right edge of each task and question (t1, q2…) is the name Claude uses for it. Click it to copy it, then paste it into the chat.
- **Claude can organise the list.** It can tag tasks (*urgent*, *important*, *quick*, *optional*, *blocked*), group them, reword them and remove ones that are no longer needed. Tags decide the order of tasks that can be done in any order. When steps must be done one after another, Claude puts them in an ordered group: they show as numbered steps in its order, and tags never move them. It can reorder the steps later if the plan changes. For a roadmap with stages (set up, then testing, then wrap up), Claude can also put the groups themselves in order: they show as Phase 1 of 3, Phase 2 of 3 and so on, and the steps are numbered across all of them.
- **Hide or close.** Closing a tab only hides that checklist. The **Claude checklists** icon in the activity bar lists every checklist with show, hide and close. Click one in the list to open it and bring it to the front. Closing a checklist for good asks first, and says what is still waiting on you (tasks not shared, questions not answered, answers not shared). It tells Claude, and the next tasks it adds start a new checklist.
- **Works with the keyboard and screen readers.** Tab moves through the checklist. Enter or Space opens and shuts a task. In a question, the arrow keys move between the choices. Enter shows a screenshot full size, and Escape closes it. Screen readers say what the colours and icons show: urgent, shared as done or not done, and whether Claude has read it.
- **Nothing is lost on reload.** Checklists survive a window reload.

Claude gets five tools:

| Tool | What it does |
|---|---|
| `checklist_add_tasks` | Adds tasks (with optional details, a command to copy, tags and a group) and opens the checklist. It doesn't wait; you work at your own pace. |
| `checklist_ask` | Asks you a question in the Decide section, with options, details and Claude's recommendation. It doesn't wait. |
| `checklist_read` | Returns only what you shared: tasks done or not done, your answers, your notes, and your screenshots as images. Everything else shows as "waiting". |
| `checklist_wait` | Waits until you share something, then returns it. Claude uses this only when your input is the only thing left. |
| `checklist_edit` | Renames the checklist, rewords tasks, changes tags and groups, updates or withdraws questions, or removes tasks. |

## FAQ

**Do I need Claude Code?** Yes. Checklist Bridge works with [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), in the terminal or in the VS Code extension. It doesn't add a chat of its own.

**Does it work in the terminal and the Claude panel?** Both. The checklist opens in VS Code either way.

**Does Claude see my checklist before I share it?** No. Claude sees only tasks and answers you've shared. Anything else shows as "waiting".

**What if I leave my computer while Claude waits for me?** Click the moon icon at the top of the checklist, pick when you'll be back, and press **Yes**. Claude stops waiting, does the work that needs nothing from you and that it can finish safely, and stops with a short summary. See [When you're away](#when-youre-away).

**Does Claude restart when I'm back?** No. Nothing wakes it when your away time ends, so a chat that has gone idle doesn't cost you anything. Press **Send now** or write to Claude to carry on.

**Does it work in Cursor or VSCodium?** Yes, install the `.vsix` ([steps above](#install)).

**Does it send my data anywhere?** No. Claude Code talks to the extension on `127.0.0.1` only. The one network request is the update check, which you can switch off.

**Something isn't working.** See [Troubleshooting](#troubleshooting), or [open an issue](https://github.com/Akshat270/checklist-bridge/issues).

## Help it grow

If Checklist Bridge saves you time, a [review on the Marketplace](https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge&ssr=false#review-details) or a star on [GitHub](https://github.com/Akshat270/checklist-bridge) helps other people find it. Ideas and bug reports are welcome in [issues](https://github.com/Akshat270/checklist-bridge/issues).

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
