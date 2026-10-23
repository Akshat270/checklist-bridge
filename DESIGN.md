---
name: Checklist Bridge
description: Agent-to-human hand-off checklist in a narrow VS Code webview column.
colors:
  ground: "#1f1f1f"
  ink: "#e6e6e6"
  ink-2: "#cccccc"
  ink-3: "#9d9d9d"
  accent: "#8b8ff9"
  accent-fill: "#5e63e6"
  accent-ink: "#ffffff"
  done: "#3fb950"
  notdone: "#f0883e"
  urgent: "#ff6a55"
  important: "#e3b341"
  quick: "#39c5cf"
  blocked: "#e26fb0"
  accent-light: "#4f54d9"
  done-light: "#1a7f37"
  notdone-light: "#bc4c00"
  urgent-light: "#d1242f"
  important-light: "#9a6700"
  quick-light: "#0e7c86"
  blocked-light: "#bf3989"
typography:
  title:
    fontFamily: "var(--vscode-font-family), -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "var(--vscode-font-family), -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: "var(--vscode-font-family), -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  body-emphasis:
    fontFamily: "var(--vscode-font-family), -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.45
  meta:
    fontFamily: "var(--vscode-font-family), -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "var(--vscode-font-family), -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
  code:
    fontFamily: "var(--vscode-editor-font-family), Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  s: "4px"
  m: "8px"
  l: "10px"
  tick: "6px"
  pill: "10px"
spacing:
  pad: "18px"
  pad-narrow: "12px"
  row-y: "9px"
  section: "18px"
  shared-section: "26px"
  indent: "40px"
components:
  task-row:
    rounded: "{rounded.l}"
    padding: "9px 10px 9px 8px"
    typography: "{typography.body}"
    textColor: "{colors.ink}"
  task-current:
    rounded: "{rounded.l}"
    typography: "{typography.body-emphasis}"
    textColor: "{colors.ink}"
  checkbox:
    rounded: "{rounded.tick}"
    size: "20px"
  checkbox-checked:
    backgroundColor: "{colors.accent-fill}"
    rounded: "{rounded.tick}"
    size: "20px"
  status-mark-done:
    backgroundColor: "{colors.done}"
    textColor: "#ffffff"
    size: "20px"
  status-mark-notdone:
    backgroundColor: "{colors.notdone}"
    textColor: "#ffffff"
    size: "20px"
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.m}"
    padding: "0 13px"
    height: "30px"
  button-small:
    rounded: "{rounded.m}"
    padding: "0 10px"
    height: "26px"
  button-quiet:
    textColor: "{colors.accent}"
    rounded: "{rounded.m}"
    padding: "0 10px"
    height: "26px"
  button-ghost:
    textColor: "{colors.ink-3}"
    rounded: "{rounded.s}"
    padding: "0 9px"
    height: "28px"
  icon-button:
    textColor: "{colors.ink-3}"
    rounded: "{rounded.s}"
    size: "28px"
  chip:
    typography: "{typography.label}"
    rounded: "{rounded.s}"
    padding: "0 7px"
    height: "20px"
  chip-urgent:
    textColor: "{colors.urgent}"
    rounded: "{rounded.s}"
    height: "20px"
  chip-important:
    textColor: "{colors.important}"
    rounded: "{rounded.s}"
    height: "20px"
  note-field:
    textColor: "{colors.ink}"
    rounded: "{rounded.m}"
    padding: "8px 10px"
  progress-bar:
    rounded: "6px"
    height: "6px"
  section-head:
    typography: "{typography.headline}"
    textColor: "{colors.ink}"
    rounded: "{rounded.s}"
    padding: "6px 8px 6px 4px"
---

# Design System: Checklist Bridge

## Overview

**Creative North Star: "The Hand-off Ledger"**

The panel is the category standard for a task list, executed at full craft for a 350 to 450px column next to a Claude chat. It borrows the editor's own ground, text colours and fonts so it reads as part of VS Code. Its own voice comes from two things only: an indigo accent for focus and primary actions, and a set of state colours that mean something. The column is read in quick glances, so hierarchy comes from real weight steps, an accent-tinted "next task" surface at the top, and coloured priority marks you can read without reading the words. Every row having the same weight would defeat the purpose.

Density is calm rather than compact: 14px list text at 1.45 line height, 9px row padding, Things-style rounded checkboxes, and Linear-style status circles and priority marks. Rows are flat until hovered or opened. The one moment of motion is the hand-off: a shared row slides out and the next task opens in its place.

The line between the user's working copy and what Claude can see is visual as well as functional. Unshared tasks carry a checkbox; shared tasks swap it for a filled green or orange circle, dim their text, and sit in their own collapsible "Shared with Claude" section below a rule. The progress bar counts only shared tasks.

**Key Characteristics:**
- Theme-bound ground, ink and font; accent and state colours owned by the panel, with darker light-theme overrides.
- One accent-tinted surface per screen: the current task. If it is urgent, the tint turns red-orange.
- State is shown by colour plus shape: checkbox, dashed "started" checkbox, filled check circle, filled minus circle, eye or clock.
- Flat, tonal depth. Inset 1px hairlines instead of drop shadows.
- A single 16px stroke icon family (1.5px stroke, round caps), drawn inline as SVG.

## Colors

The palette has two parts: neutrals taken from the editor theme, and a set of saturated state colours that keep their meaning in every theme.

### Primary
- **Signal Indigo** (`accent`, light theme `accent-light`): the focus ring, caret, text selection, hover border on the checkbox, quiet-button text, the dashed "started" checkbox, and the tint and hairline of the current task's surface.
- **Deep Indigo Fill** (`accent-fill`): the solid fill behind primary buttons and checked checkboxes, with white (`accent-ink`) on top. In light themes the fill and the accent are the same `accent-light`.

### Secondary (state)
- **Shared Green** (`done` / `done-light`): shared-as-done circle, the green part of the progress bar, "Claude has read this" eye, the all-done banner tint.
- **Not-done Orange** (`notdone` / `notdone-light`): shared-as-not-done circle and the orange part of the progress bar.

### Tertiary (priority and tags)
- **Alarm Red-Orange** (`urgent` / `urgent-light`): the urgent priority square, urgent chip, a red-tinted outline on unchecked urgent checkboxes, and the urgent version of the current-task surface.
- **Amber** (`important` / `important-light`): the important priority bars and chip.
- **Teal** (`quick` / `quick-light`) and **Orchid** (`blocked` / `blocked-light`): chip colours for the quick and blocked tags only.

### Neutral
- **Editor Ground** (`ground`, from `--vscode-editor-background`): page background. The hex is the dark fallback; the live value is the user's theme.
- **Ink** (`ink`, from `--vscode-editor-foreground`): task text, titles, counts in bold, note text.
- **Ink 2** (`ink-2`, from `--vscode-foreground`): body default, detail text, count-pill text.
- **Ink 3** (`ink-3`, from `--vscode-descriptionForeground`): metadata, placeholders, icon buttons at rest, shared-task text, the optional chip.
- **Derived surfaces** (all `color-mix` of ink into ground or transparent): line 11%, strong line 20%, hover 5%, open-row surface 4%, note field 6%, code well 8%. These follow the theme automatically. Do not hard-code them.

### Named Rules
**The Meaning-Only Colour Rule.** Every saturated colour stands for one state or priority (indigo means action or focus, green means shared as done, orange means shared as not done, red-orange means urgent, amber means important). Never use a state colour for decoration.

**The Theme-Owns-the-Ground Rule.** Ground, text and fonts always come from `--vscode-*` variables with fallbacks. The panel adds tints by `color-mix` over those variables, never by fixed greys.

**The Two-Theme Rule.** Every owned colour has a darker override under `body.vscode-light` and `body.vscode-high-contrast-light` so it keeps contrast on white; high-contrast themes swap the lines to `--vscode-contrastBorder` and `--vscode-contrastActiveBorder`.

## Typography

**Body Font:** the VS Code UI font (`--vscode-font-family`, falling back to -apple-system, Segoe UI, system-ui)
**Mono Font:** the editor font (`--vscode-editor-font-family`, falling back to Menlo, Consolas)

**Character:** The editor's own fonts, made clear through weight and size steps rather than a separate typeface. There is one family, and its weights (400, 550, 600, 650) do the work.

### Hierarchy
- **Title** (650, 18px, 1.3, -0.015em, balanced wrapping): the checklist name at the top. Only one per panel.
- **Headline** (650, 14px): group headers and "Shared with Claude", each followed by a pill count.
- **Body** (400, 14px, 1.45): task text, clamped to two lines when the row is closed. Urgent closed rows go to 550; the current task goes to 600. Shared tasks drop to Ink 3.
- **Meta** (400, 13px): subtitle, progress label, section hint, buttons (600 on filled buttons), status text, dock text. Detail and note text inside open rows use 14px at 1.55.
- **Label** (600, 12px): chips and count pills. Soft and optional chips use 500.
- **Code** (12.5px mono, 1.5): command wells only.

### Named Rules
**The Tabular Numbers Rule.** Counts (progress label, section pills) use `font-variant-numeric: tabular-nums` so they do not shift when they change.

**The Weight-Is-Priority Rule.** Closed rows signal rank through weight: 400 for normal, 550 for urgent, 600 for the current task. Do not add sizes to show rank.

## Layout

A single column, `max-width: 640px`, with 18px side padding (12px below 360px wide) and 96px of bottom padding so the dock never covers the last row. Reading order is fixed: header (title plus icon actions in a two-column grid, subtitle below), progress bar and label 16px below, then the current task alone in its own section, then ungrouped tasks, then named groups (18px apart), then the "Shared with Claude" section set 26px down behind a top rule.

Task rows are a three-column grid: 22px control column, flexible text, auto-width right slot for priority mark or quick-share. Open rows indent their body 40px so notes, commands and actions line up with the task text, not with the checkbox. Inside a row, the rhythm is 4 to 12px; between sections, 18 to 26px.

Ordering is part of the layout: within each group urgent comes first, then important, then the rest in Claude's order. The current task is the highest-ranked unshared task and is pinned above every group.

## Elevation & Depth

Flat by default, with depth shown by tone. Open rows lift with a 4% ink surface and an inset 1px hairline; the current task uses an accent tint (13% in dark, 8% in light) with a 38% accent hairline. Nothing at rest casts a shadow.

### Shadow Vocabulary
- **Hairline** (`box-shadow: inset 0 0 0 1px var(--line)`): open rows and screenshot thumbnails.
- **Accent hairline** (`box-shadow: inset 0 0 0 1px var(--accent-line)`): the open current task.
- **Focus halo** (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)`): the focused note field.
- **Lightbox lift** (`box-shadow: 0 12px 40px rgba(0,0,0,.5)`): only the full-screen screenshot viewer.

The dock is the only frosted layer: 88% ground with an 8px backdrop blur and a top rule.

### Named Rules
**The Inset-Not-Drop Rule.** Containers in the list are outlined with inset hairlines, never drop shadows. A real shadow is reserved for the overlay lightbox.

## Shapes

Soft corners on three steps: 4px for chips, icon buttons, ghost buttons and section headers; 8px for buttons, note fields, code wells, thumbnails and toasts; 10px for task rows and the all-done banner. Checkboxes are rounded squares (6px on 20px) in the Things style, and shared-state marks are full circles. The circle-versus-square difference is the shared/unshared line. Count pills and the progress bar are fully rounded. Borders are 1px hairlines, apart from the 1.5px checkbox outline.

## Components

### Task Row (signature)
The list's unit: checkbox, text with chips beneath, and a right slot.
- **Closed:** transparent, 5% hover tint, text clamped to two lines. The right slot shows the priority mark, or a quiet "Share" button once ticked.
- **Open:** 4% surface with a hairline. Reveals detail, command well, note field, thumbnails, and an actions row ("Add image" ghost on the left, share button on the right).
- **Current:** open by default, accent-tinted surface, 600 text, group name shown as a soft chip. It turns red-orange when urgent.
- **Started** (note or image added, not ticked): the checkbox goes dashed in accent with a light accent fill.
- **Shared:** the checkbox is replaced by a filled circle (green check or orange minus), text drops to Ink 3, and the right slot shows an eye in green (read) or a clock in Ink 3 (not read yet). Opening it shows the shared note and a "Take back" ghost.

### Checkbox
- **Shape:** 20px rounded square (6px), 1.5px strong-line border.
- **States:** border turns accent on hover; it scales to 0.9 when pressed; when checked it fills with Deep Indigo and draws a white check that scales in. Unchecked urgent rows tint the border red-orange.

### Priority Marks
16px filled glyphs in the right slot of closed rows: a red-orange rounded square with a white exclamation mark for urgent, and three rising amber bars for important. When a row opens they are replaced by chips.

### Buttons
- **Primary** (`button-primary`): Deep Indigo fill, white 13px/600 text with a 14px icon. Hover brightens to 1.1; pressed moves down 1px. Used for "Share as done" and "Share all".
- **Secondary:** line-tinted fill with ink text. Used for "Share as not done", so the not-done path is visibly the weaker action.
- **Quiet** (`button-quiet`): 16% accent tint with accent text, darkening to 26% on hover. Used for the inline quick-share.
- **Ghost** (`button-ghost`): no fill, Ink 3 text with a 15px icon, hover tint plus ink text. Pulled left 9px so its icon lines up with the text.
- **Icon button** (`icon-button`): 28px square, Ink 3, hover tint. Used for hide and close in the header.

### Chips
20px tall, 4px corners, 12px/600 label. Coloured tags take their colour for the text and a 14% tint of it for the fill (urgent, important, quick, blocked). Optional tags use Ink 3 at 500. Soft chips (group name, note and screenshot indicators) use a line-tinted fill and Ink 3 text, with an optional 12px icon.

### Inputs / Fields
- **Note field:** full-width textarea, 8px corners, strong-line border, 6% field fill, vertically resizable from 64 to 280px.
- **Focus:** border turns accent and a 3px soft accent halo appears; the default outline is suppressed only here.
- **Command well:** 8% code fill, mono text, joined to a copy button by a hairline divider.

### Progress
A 6px rounded track in line colour, filled left to right with green (shared as done) then orange (shared as not done), animated over 0.45s. Below it, "**n** to do" on the left and "**x** of y shared" on the right, with the numbers in ink 600.

### Section Header
A full-width button: 14px chevron (rotates −90° when collapsed), 14px/650 label, a tabular count pill, and an optional right-aligned Ink 3 hint ("2 not read yet" / "All read").

### Dock
A fixed footer that slides up when two or more ticked tasks are waiting: frosted ground, top rule, "**n** ticked and not shared yet" with a primary "Share all".

### Feedback
- **Toast:** inverted (ink fill, ground text), 12.5px/500, 8px corners, fades and rises above the dock.
- **All-done banner:** 10% green tint, green check circle, ink headline and Ink 2 line.
- **Empty state:** left-aligned 15px/600 headline with a short Ink 3 explanation.

### Motion
One easing curve, `cubic-bezier(.16, 1, .3, 1)`, for everything that moves position. A shared row leaves (0.22s, fade and 12px slide right); the next current task arrives (0.38s, fade and 6px rise). Hover tints and colour changes take 0.12 to 0.15s with plain ease. `prefers-reduced-motion` turns off every animation and transition, and the share then happens instantly.

## Do's and Don'ts

### Do:
- **Do** take ground, text and fonts from `--vscode-*` variables, and build surfaces with `color-mix` of ink into ground (hover 5%, open row 4%, field 6%, code 8%, line 11%, strong line 20%).
- **Do** give every owned colour a `body.vscode-light` (and `body.vscode-high-contrast-light`) override that is dark enough for body-size text on white.
- **Do** pair every state colour with a shape or icon: check vs minus circle, eye vs clock, square vs bars, dashed vs solid checkbox.
- **Do** keep exactly one tinted surface on screen: the current task.
- **Do** use the 16px stroke icon family (1.5px stroke, round caps and joins), inline as SVG and sized 11 to 16px.
- **Do** show the visible focus outline (2px accent, 2px offset) on every control; the border-plus-halo of the note field, the answer choices and the task rows is the only replacement.

### Don't:
- **Don't** use a state or priority colour for anything that is not that state or priority.
- **Don't** use drop shadows on list content; use the inset hairline.
- **Don't** blur the shared line: unshared tasks always show a checkbox, shared tasks always show a filled circle, and progress counts only shared tasks.
- **Don't** add a filter control or tabs to the column; collapsible sections do that job.
- **Don't** load network fonts or fixed greys; the theme supplies both.
- **Don't** add motion beyond the leave/arrive hand-off and small state transitions, and never without the reduced-motion override.
