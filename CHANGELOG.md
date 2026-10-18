# Changelog

## Unreleased
- **Steps that must be done in order now show in order.** Claude can mark a group of tasks as steps. They show as Step 1, Step 2 and so on, in Claude's order. An *important* or *urgent* tag no longer moves a later step to the top.
- **Roadmaps with stages.** Claude can mark groups as phases that must be done one after another, for example *Setting up*, then *Testing*, then *Wrapping up*. The phases show in order (Phase 1 of 3…), the steps are numbered across all of them (Step 4 of 7), and only the first open step is next.
- The next task stays in its group when it is a step. Tasks that can be done in any order are still sorted by their tags.
- Claude can reorder the steps later if the plan changes. Steps you have already shared stay where they are.
- **Open tasks are shorter.** *Add image* is now a small picture icon in the corner of the note box. You can still paste an image into the note.
- **Task ids** (t1, q2…) now sit at the right edge of each row, not in front of the title. Click one to copy it, as before.

## 0.5.1
- Fixed checklists going missing after **Reload Window**. If the old window was slow to close, the new one skipped your checklists and never looked again, so the tab stayed closed and the list was empty. It now keeps looking and brings them back as soon as they are free.
- Clicking a checklist in the **Claude checklists** list now always opens it and brings it to the front. Before, clicking one that was already open (for example behind other tabs) closed it. Use the eye button on the row to hide a checklist.

## 0.5.0
- When several VS Code windows are open as the extension installs, only one of them connects Claude Code and says so (they used to all connect at once, each showing a message).
- **Every task and question shows its id** (t1, q2…), the same one Claude uses, so when Claude says "clear q1" you can find it. Click an id to copy it into the chat. Claude is also told to give a few words of the title with the id.
- Fixed the **Share** button and the urgent mark being pushed past the edge of a collapsed task that has a long title or group name. Long group names now end in "…".
- **Security: a project's settings can no longer redirect updates or run programs.** `checklistBridge.updateRepo`, `autoUpdate`, `autoConnect` and `claudePath` are now read only from your own user settings. Before, a repository's `.vscode/settings.json` (in a trusted folder) could point the updater at another repo, or name a program to run as `claude`.
- **Disconnect stays disconnected.** Automatic connecting happens until the first success. If the connection is later removed outside VS Code, you're asked once whether to reconnect instead of it being re-added silently.
- The connection now uses Node.js by its full path, so it works however Claude Code is started, and it repairs itself if that Node.js is upgraded or removed.
- "Start a new Claude chat" in *Getting started* is ticked by Claude's first checklist, not by the example.
- **Connecting is automatic.** The first time VS Code starts, Checklist Bridge finds Claude Code and connects itself, with no terminal and no command to press Enter on, then confirms it worked. If Claude Code isn't installed, it says so and links to the install page; it reconnects on its own once you install it. New: *Getting started* walkthrough, *Disconnect Claude Code*, and the `checklistBridge.autoConnect` and `checklistBridge.claudePath` settings.
- The **Claude checklists** sidebar shows whether Claude Code is connected, with a **Connect** button when it isn't.
- **Windows without a folder no longer mix up checklists.** They share one storage folder, so a second such window showed the first window's checklists and could overwrite its changes. Each checklist now belongs to one window; when that window closes or crashes, the next window takes it over.
- **Faster start with many screenshots.** Screenshots are no longer read into memory when VS Code starts; Claude's reads load them from disk when needed.
- Screenshots of a checklist that fails to load are no longer deleted.

## 0.4.5
- **Screenshots are stored as image files.** A checklist's own file now stays a few KB however many screenshots it has, so saving is instant, and the panel loads screenshots straight from disk instead of receiving them on every update. Checklists from earlier versions are converted automatically.
- Fixed a case where saving could stop for the rest of the session after a checklist was deleted.
- If one checklist's file stays locked, the others keep saving at normal speed.
- After a restart, two checklists with the same title both come back.
- Test dependencies are pinned with a lockfile, and the tests (131 checks) run on Linux, Windows and macOS.

## 0.4.4
- **Saving is more reliable on Windows.** If antivirus or the search indexer briefly locks a checklist file, the save is retried instead of dropped, and a change that can't be saved yet stays queued until it can.
- **No more stutter with screenshots.** Checklists are saved in the background instead of blocking VS Code while large screenshots are written.
- **No duplicate tabs after a restart.** If VS Code is still holding a checklist's tab, the extension doesn't open a second one.
- Tests now ship with the source: `npm test` runs 113 checks against the real extension, and GitHub runs them on every change.

## 0.4.3
- **Checklists survive reloads and restarts again.** VS Code closes every tab while a window shuts down, and those closes were being saved as "hidden", so checklists didn't come back. Now VS Code reopens the tabs that were open, and anything you hid yourself stays hidden.
- Changes are saved within a third of a second of the first edit (before, constant typing kept postponing the save), written safely, and saved once more when the window closes. Notes you were typing are saved when the panel loses focus.

## 0.4.2
- Fixed **Take back** running past the edge of an open shared task, and **Share answer** running off a question card, in narrow panels. Long status lines now wrap instead.
- An open shared task no longer shows its "not read yet" status twice, and has less empty space.

## 0.4.1
- **Safer Send now in the terminal.** Send now types into a terminal only while Claude is still running there. After you quit Claude, it copies the update for you instead of typing into your shell. Control characters are removed from what it types.
- Pressing Send now twice no longer sends the same update twice.
- One Send now button instead of two: it sits on the answer when that's the only thing waiting, otherwise in the bar below your tasks ("1 task and 1 answer not read yet").
- If VS Code is slow to answer, Claude no longer adds the same tasks or question to another window. It's told to check the checklist first.
- Chats that have ended are forgotten, and an answer is marked as read only when Claude actually receives it.

## 0.4.0
- **Questions you can answer later.** Claude asks decisions that can wait in a new **Decide** section, with options, details and its recommendation, instead of listing options in the chat. Pick one (or several), or write your own answer, then **Share answer**.
- **Send now.** Hand what you shared to Claude right away. It reaches Claude while it waits on the checklist, types into Claude's VS Code terminal, or pushes through Claude Code channels (*Start Claude with Send now*). In the idle Claude panel it becomes **Copy for chat**.
- Claude can now wait for your input (`checklist_wait`) instead of ending its turn; the panel shows when it's waiting.
- The instructions added by *Make every Claude Code chat use checklists* now cover questions too, and update themselves.

## 0.3.2
- One click makes every Claude Code chat on your computer use the checklist without being told: *Checklist Bridge: Make every Claude Code chat use checklists*. It adds a marked instruction to `~/.claude/CLAUDE.md` and allows the checklist tools in `~/.claude/settings.json`. *Undo Claude Code setup* reverses it.
- The README now leads with installing from the VS Code Marketplace.

## 0.3.1
- Published on the VS Code Marketplace as `Akshat270.checklist-bridge`. The old `akshat.checklist-bridge` copy removes itself.

## 0.3.0
- First public release.
- New icon and a README for new users, with screenshots and a one-click download link.

## 0.2.x
- Redesigned panel. The next task is pinned at the top, and urgent tasks jump ahead and turn it red. The progress bar counts only shared tasks. Tick several tasks and use **Share all**. Shared tasks move to a **Shared with Claude** section that shows which ones Claude has read.
- Self-updating from GitHub.
- Shorter placeholder in the note box.

## 0.2.0
- One checklist per Claude chat, opened in the VS Code window where that chat runs.
- Tasks don't block the chat. You tick a task, add a note or screenshots, and share it when ready. Claude reads only shared tasks.
- Claude can tag, group, reword and remove tasks.
- A sidebar to show, hide and close checklists.

## 0.1.0
- First version: a blocking checklist that sent the whole list to Claude when you saved it.
