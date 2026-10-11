# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Akshat, a developer and founder who runs several Claude Code agents at once inside VS Code (for example while building Unilytic). While an agent works, it hands him things only a human can do: create accounts and keys, run commands, click through dashboards, test pages, report values. He works through these between conversations with the agents.

## Product Purpose
Checklist Bridge gives each Claude chat its own checklist inside VS Code. The agent adds tasks; the user ticks them, adds notes and screenshots, and shares each task when ready. The agent can read only shared tasks. Success: the user always knows what an agent is waiting on, what is urgent, and what to do next, without scrolling the chat.

## Positioning
A hand-off channel from agent to human, not a to-do app: tasks are written by the agent, confirmed by the human one at a time, and the agent's view is limited to what was confirmed.

## Operating Context
- Shown as a narrow column (roughly 350–450px) next to the Claude chat, glanced at often.
- One VS Code window can hold several checklists (one per chat); each can be hidden or shown.
- A checklist usually holds 5–15 tasks, sometimes grouped, sometimes tagged (urgent, important, optional, quick, blocked).
- Task states: untouched, started (ticked or note/screenshot added, not shared), shared as done, shared as not done, and whether the agent has read it.

## Capabilities and Constraints
- Runs in a VS Code webview: no network fonts by default, theme variables available, strict CSP.
- Must stay readable in the user's dark theme; light themes must also work.
- Controls are standard ones: checkboxes, buttons, text areas, tabs.

## Brand Commitments
- Standing preference: the familiar category standard, executed at full craft, rather than a themed visual world (chosen by the user over a themed direction, 2026-10-11).
- Craft bar delegated to Claude: the polish of Linear and the calm readability of Things 3.

## Product Principles
1. Urgent first, then the next thing to do, then overall progress.
2. Readable at a glance in a narrow column: strong contrast, clear size and weight steps.
3. Colour carries state and priority; a flat grey screen is a failure, not restraint.
4. The agent's view is what the user shared; the UI never blurs that line.

## Accessibility & Inclusion
Body text at least 4.5:1 contrast; nothing important carried by colour alone.
