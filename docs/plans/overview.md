# Plan: the Overview (every checklist, every project, in one place)

Status: proposal. Nothing here is built yet.

## The problem

Today each VS Code window shows only its own chats' checklists. Someone running agents in four projects has to visit four windows to find out which agent is stuck. That breaks the product's promise: "the user always knows what an agent is waiting on, what is urgent, and what to do next".

## What we are building

One view that answers two questions across every project and chat:

1. **What should I do right now?** A ranked "Now" list.
2. **Where does everything stand?** Every project, its chats, and their progress.

It comes in four sizes. The user picks how much room it gets.

| Size | Where | What it shows | Cost |
|---|---|---|---|
| Badge | Activity bar icon and status bar, in every window | "2 waiting" | Nothing extra |
| Section | "Needs you" section in the Checklist Bridge sidebar, in every window | Top 7 items, one line each | Almost nothing (native tree, no webview) |
| Tab | Overview opened as an editor tab in the current window | Everything | One webview |
| Window | The Overview window: its own VS Code window with no project | Everything, full screen | One extra VS Code window |

The tab and the window show **the same page**. The page adapts to its width. So "both options" is one piece of UI with two ways to open it, plus the small sidebar section.

## How the user opens it

**The small section** is there by default, under the existing "Checklists" list in the sidebar. It is empty and collapsed when nothing needs the user. Users who don't want it hide it the normal VS Code way (right-click the section header). Users can also drag it into the bottom panel or the secondary sidebar, as with any VS Code view.

**The Overview tab:**
- "Open Overview here" button in the "Needs you" section header.
- Command: "Checklist Bridge: Open Overview".
- Clicking the status bar count.

**The Overview window:**
- "Open in its own window" button in the "Needs you" section header, and in the Overview tab's header.
- Command: "Checklist Bridge: Open Overview Window".
- After the first time, VS Code reopens it on restart. It is also in File → Open Recent as "Overview".

If the Overview window is already open, every one of these brings it to the front instead of opening a second one.

### How the Overview window works

- The extension writes `~/.checklist-bridge/Overview.code-workspace`: a workspace with no folders and a few settings (below). It opens it with `vscode.openFolder` in a new window.
- When the extension starts and sees that this workspace file is open, it goes into **overview mode**:
  - opens the Overview page in the main editor area,
  - closes the sidebar, bottom panel and secondary sidebar,
  - registers itself with `role: "overview"` so chats don't land here (see "Chats must not land in the Overview window").
- The window title shows "Overview" (workspace name). This makes it easy to find with Alt-Tab and in the taskbar.

## Where the data comes from

### Summary files (reading)

Each project window writes a small summary of its checklists to `~/.checklist-bridge/summaries/<windowId>.json`:

- after any checklist change, at most once a second;
- when a chat starts or stops waiting;
- when the window closes, with `open: false`.

Readers (the sidebar section, the Overview page) watch that folder with `fs.watch`, and fall back to reading it every 10 seconds if watching fails.

Why files, not HTTP calls to every window:
- **Cheap.** If five windows each showed the section and polled the other four, that would be 20 requests every few seconds. With files, each window writes only when something changes, and reading costs nothing while nothing changes.
- **Closed projects for free.** A closed window's file stays, marked `open: false`. That lists the checklists of projects that aren't open right now, without searching VS Code's storage folders (which differ by OS and by editor: Insiders, Cursor…).
- **Safe.** Readers never touch checklist files. Only the owning window writes those, through `Saver`.

The file is written like the registry: atomic tmp+rename, mode `0600`. Files of windows closed for more than 30 days, or with nothing left to do, are deleted.

What goes in a summary (no screenshots, no draft notes, texts cut to 200 characters):

```jsonc
{
  "version": 1,
  "windowId": "ws-…", "pid": 1234, "open": true, "updatedAt": 0,
  "name": "unilytic", "folders": ["/home/me/unilytic"],
  "checklists": [{
    "id": "…", "title": "Billing setup", "folder": "/home/me/unilytic",
    "chat": { "alive": true, "waitingSince": 0, "lastCall": 0, "away": false },
    "counts": { "tasks": 8, "shared": 5, "questions": 2, "answered": 1 },
    "items": [{ "id": "q3", "kind": "question", "text": "Pick the payment provider?",
                "tags": [], "group": null, "nextStep": true, "addedAt": 0, "state": "untouched" }]
  }]
}
```

`waitingSince` is new: `windowServer` records when a `checklist_wait` call starts. Today it only knows whether one is open.

### Actions (writing)

Clicking an item, ticking a task, or answering a question is sent to the owning window over its existing local HTTP server and token (from the registry), on new routes kept separate from the ones chats use. The owning window changes the checklist the same way its own panel would, and saves it through `Saver`. The Overview never edits checklist files itself.

### Bringing the right window to the front

The Overview asks VS Code to open the project's folder (`vscode.openFolder`). If that folder is already open, VS Code brings that window to the front instead of opening it twice. The Overview also tells that window to show the checklist.

- **Closed project:** "Open project" opens it. Its checklists come back with it, as they do today.
- **Window with no folder:** it can't be focused by path. The checklist is shown there anyway, and the Overview says which window it is in.

## Ranking: what counts as urgent

The ranking lives in a new module, `src/summary.ts`, with no `vscode` import. It is tested in Node like `model.ts`. Each item gets a level and a short reason shown as a chip.

| Level | When | Chip |
|---|---|---|
| 1 | Claude is in `checklist_wait` for this chat | "Claude waiting · 6m" |
| 2 | Chat is running, Claude has made no call for 2+ minutes, and items are waiting | "Claude paused" |
| 3 | Unanswered question | "Decide" |
| 4 | Tagged `urgent` or `blocked`, or the next step of an ordered group | "Urgent" / "Blocked" / "Next step" |
| 5 | Tagged `important` | "Important" |
| 6 | Everything else that is waiting. `quick` items get a "2 min" chip | — |
| 7 | Chat no longer running, or project closed | "Chat ended" / "Project closed" |

Within a level: items that unblock more later steps first, then the oldest first. Steps later in an ordered group never appear in "Now", only their group's next step. Chats where the user said they are away drop to level 6 and show "Away".

"Claude paused" is a guess: the extension can't see the chat itself. The chip says "paused", not "waiting for you". A later version can make it exact with a Claude Code `Stop` hook that tells the window when a turn ends.

## UI and UX

Follows `PRODUCT.md` and `DESIGN.md`: urgent first, then the next thing, then progress. Same type scale, same tag colours, plus one new colour for "Claude waiting" (light and dark versions, contrast checked).

### Sidebar section "Needs you"

A native tree view (`TreeView`), so it looks like the rest of VS Code and costs almost nothing.

```
NEEDS YOU                       [⧉ tab] [⇱ window]
 ● q3 Pick the payment provider?   unilytic · Billing
 ● t4 Add STRIPE_KEY to .env       unilytic · Billing
 ▲ t2 Renew the SSL cert           shop-api · Deploy
   q1 Keep the old login page?     website · Auth
   + 9 more in 4 projects
```

- Icon colour shows the level. The level is also in the tooltip, so colour isn't the only signal.
- Label: item id and text. Description: project · chat, cut off with "…" when long.
- Click: bring the owning window to the front with that checklist open.
- The last row opens the Overview.
- The activity bar badge (`TreeView.badge`) shows how many agents are waiting.
- When the only items are from this window, the section still shows them. The section is about "what's next", not "what's elsewhere".

### Overview page (tab or window)

**Header (always):** "2 agents waiting · 3 decisions · 11 tasks · 4 projects". Filter chips: Waiting, Decide, Urgent, All. Search box. "Away for all chats" button, which sets away on every open chat.

**Wide (1100px and up), the usual Overview window:**

```
┌ Now ─────────────────────┬ unilytic ───────────────┬ shop-api ─────────────┐
│ ● q3 Payment provider    │ Billing setup ● waiting │ Deploy fixes          │
│   unilytic · Billing     │ ▓▓▓▓▓░░░ 5/8            │ ▓▓░░░░ 2/6            │
│ ● t4 STRIPE_KEY          │  q3 · t4 · t5           │  ▲ t2 SSL cert        │
│ ▲ t2 SSL cert            ├─────────────────────────┤ Old chat · ended      │
│ …                        │ Inventory sync  ✓ done  │  2 left               │
└──────────────────────────┴─────────────────────────┴───────────────────────┘
```

- Left: the Now list, 360px wide, scrolls by itself.
- Right: one card per project, in a grid. Projects with something waiting come first, closed projects last and greyed.
- Each card lists its chats. Each chat shows a status chip (Waiting 6m, Paused, Running, Ended), a progress bar of shared/total, and its top 3 waiting items.

**Medium (700–1100px):** Now list on top, project cards below in two columns.

**Narrow (under 700px, e.g. a tab beside code):** one list, the same as the sidebar section but with more rows and project headings.

**Acting on items:**
- Hover a row (or move to it with the keyboard): "Open", plus quick actions.
- Task: a tick box and "Share as done".
- Question with options: the options as buttons, then "Share answer".
- Anything needing notes or screenshots: "Open" goes to the chat's own checklist, which already does all of that well. The Overview links to it rather than copying it.

**Keyboard:** ↑/↓ to move, Enter to open, `/` to search, `1`–`4` for the filters.

**Live updates:** changed rows fade in. Rows don't jump while the mouse is over the list; new order applies when the mouse leaves.

**Empty states:**
- Nothing waiting: "Nothing needs you. 3 agents are working." plus the list of running chats.
- No other windows: "Open a project with Claude chats and its checklists show up here."
- A window running an older version of the extension (no summary file): "Reload the window for <name> to see it here."

### Notifications

When an agent starts waiting, one VS Code notification: "Claude is waiting on you in unilytic · Billing setup" with an "Open" button. Only one window shows it:
- the Overview window, if one is open;
- otherwise the window that owns the chat (as now).

A setting turns this off.

## Keeping memory low

**Sidebar section and badge:** a native tree view, no webview. Data comes from small files that are read only when they change. It does nothing while the section is collapsed or hidden (`onDidChangeVisibility`).

**Overview page:**
- One webview. Plain HTML/CSS/JS like `media/panel.js`, no framework.
- No screenshots. Only text from the summary files, a few KB per project.
- No `retainContextWhenHidden` for the tab. It redraws from the summaries in a moment when shown again. The Overview window keeps it, since it's always shown there.
- Redraws only the rows that changed.

**Overview window:** the extra window is most of the cost (a few hundred MB, mostly VS Code itself). Most of that is fixed, but we can cut the rest:
- The workspace file has no folders, so there's no file watching, search index, git or language servers.
- Settings in the workspace file turn off things it doesn't need: `git.enabled: false`, `workbench.startupEditor: none`, `extensions.ignoreRecommendations: true`, `workbench.editor.restoreViewState: false`.
- The extension does less in overview mode: no `claude mcp` checks, no setup prompts, no updater (the project windows handle it).
- **Later, optional "light" mode:** open the window with its own VS Code profile (`code --profile "Checklist Overview"`) that has only Checklist Bridge installed. Then none of the user's other extensions load there, which saves the most memory. It also stops Claude Code chats being started in that window. This needs testing first (see the open questions): creating the profile and installing the extension into it must work on all three OSes, for Marketplace and GitHub installs.

Users who don't want an extra window at all use the tab or the section.

## Chats must not land in the Overview window

When a chat can't tell which window it belongs to, `pickWindow` falls back to "the window used most recently" (`src/registry.ts`). A user who keeps clicking into the Overview window would make it that window. Chats started in an outside terminal would then put their checklists there.

Fix: windows in overview mode write `role: "overview"` in their registry file, and `pickWindow` skips them, except for a chat that was actually started from that window (`CHECKLIST_BRIDGE_WINDOW`). This needs a regression test.

## Building it, in pull requests

Each step is one pull request, useful on its own.

1. **Summary files and ranking.** `src/summary.ts` (build the summary, rank items), writing summary files from `extension.ts`, `waitingSince` in `windowServer.ts`. No UI yet. Tests: ranking cases; two fake windows writing and reading summaries; a closed window marked `open: false`.
2. **"Needs you" sidebar section and badge.** Read-only: click opens the item in its window. Includes the focus/reveal route and the status bar count.
3. **Overview page as a tab.** Wide, medium and narrow layouts, filters, search, keyboard. Read-only plus "Open". Panel tests at the three widths (Linux CI, like the other panel suites).
4. **Overview window.** The workspace file, overview mode, the `pickWindow` change with its test, the lighter settings.
5. **Acting from the Overview.** Tick, share, answer questions, "Away for all chats". Each action goes through the owning window.
6. **Notifications**, only one window at a time.
7. **Later:** "light" profile mode, the `Stop` hook for an exact "paused" signal, and a local browser page for when VS Code isn't open.

Each user-visible step adds a line to `CHANGELOG.md` and updates `README.md`. Claude's instructions (`SERVER_INSTRUCTIONS`, `INSTRUCTIONS`) don't change: Claude's side of the checklist stays the same.

## Open questions to test first

1. Does `vscode.openFolder` on an already-open folder bring that window to the front on Windows, macOS and Linux, without opening a duplicate? If not, the fallback is to show the checklist in that window and tell the user which window to switch to.
2. Is `fs.watch` on the summaries folder reliable on all three OSes, including network home folders? The 10-second fallback covers it either way.
3. Can the extension create a profile and install itself into it from the `code` command line, for both Marketplace and GitHub installs? This decides whether the "light" mode is possible.
4. VS Code, Insiders and Cursor all share `~/.checklist-bridge`. Opening a project from the Overview could open it in the wrong editor. The summary should record which editor wrote it (`vscode.env.appName`) and the Overview should only offer "Open project" for its own editor.
5. Is 2 minutes the right idle time for "Claude paused"? Try it with real chats before fixing the number.
