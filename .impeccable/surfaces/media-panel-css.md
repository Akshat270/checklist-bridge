---
version: 1
slug: "media-panel-css"
primary_target: "media/panel.css"
related_targets: ["media/panel.js"]
---

Scope: the checklist panel (media/panel.css, media/panel.js), Operate mode, code-led. Narrow column beside the Claude chat, 5–15 tasks.

Audience and job: developer working several agents; glances to see what is urgent, what to do next, and progress; ticks, notes and shares tasks.

## Direction contract

THESIS: A task list as good as the category's best, built for a 400px column: one obvious next task, priority you can see without reading, and a clear line between what you are working on and what Claude can see. Refuses the flat grey list where every row has the same weight.

OWN-WORLD: Canon, executed straight. Theme ground and foreground; an indigo accent for focus and primary actions; state colours that mean something (green shared-done, orange shared-not-done, red-orange urgent, amber important). Linear-style status circles and priority marks; Things-style rounded checkboxes and generous line height. 14px list text, 18px title, real weight steps.

STORY: The user sees the next task open and highlighted, ticks it, adds a note, shares; it drops into "Shared with Claude" and the next task opens. They can tick several and share all at once.

FIRST VIEWPORT: Title and actions; progress bar with "x of y shared" (counts only what Claude can see); the next task (urgent first) pinned at the top, expanded on an accent-tinted surface; then groups; collapsed one-line rows below with status circle, text, priority mark; a collapsible "Shared with Claude" section at the bottom (replaces a filter control: one fewer control in a narrow column); a sticky footer appears when two or more ticked tasks are waiting to be shared.

FORM: category standard (standing exit), seed key 707b028f (degraded roll; assigned candidate 7 declined by the user).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
