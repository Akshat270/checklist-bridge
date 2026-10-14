# Changelog

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
