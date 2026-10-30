// The checklist pane, drawn with Claude Code's own elements: the same checklist as the VS Code panel,
// laid out for a terminal column. The design is the "Checklist Bridge mod redesign" canvas:
//
//   Title                                       3/10 ━━━━━━━━─────   progress: green done, amber not done
//   1 decision · 6 tasks waiting on you    [☾ Away] [➤ Send 1 update] actions live in the header
//   ☾ AWAY card / ✓ Sent to Claude                                   only when they apply
//   DECIDE 1 ─────────────────────────────                           section: word, count pill, rule
//   ╭ question card ╮                                                options picked with 1–9
//   TO DO 6 ──────────────────────────────
//   ╭ NEXT card ╮                                                    the open task; the rest one line each:
//    • t7 │ 1. Open the ordered group                                mark · id │ text, one grid for every row
//   ▸ SHARED WITH CLAUDE 3   2 read · 1 not done ──
//   ──────────────────────────────────────
//    d done  n couldn't  v paste  c copy  1-9 pick  a away  s send   the key bar
//
// Colours come from theme.ts, one meaning each. Cards are framed, never filled: a terminal with few colours
// turns a dark tint into a loud one, so fills are kept to small things (badges, buttons, the command well). A pointer inverts the button under it, so every button
// holds only what you click (a choice, a task's text), never the summary or badges beside it.
// No `$` here: register.tsx resolves the elements and passes in what a press should do.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { App } from './app'
import { AWAY_CHOICES, EXTEND_MS, awayFor, leftText } from './away'
import { awayDay, groupsOf, isSequence, MAX_AWAY_MS, sequenceOf, type Checklist, type Img, type Question, type Task } from './lib/model'
import type { Palette } from './theme'

export type Actions = {
  /**
   * Makes a change to the checklist `listId`: register.tsx reads the latest from disk first, runs `change`,
   * then saves and redraws. `change` uses ids, not the objects drawn here, which may be out of date by then.
   * A string it returns is shown as a message, and nothing is saved.
   */
  edit: (listId: string, change: () => string | void) => Promise<void>
  toast: (text: string) => void
  /** Send now. */
  send: (c: Checklist) => Promise<void>
  /** Saves the image on the clipboard as a screenshot of this task or question. */
  paste: (c: Checklist, itemId: string) => Promise<void>
  /** Puts text on the clipboard of the surface the press came from. */
  copy: (text: string, surface: RenderSurface) => Promise<void>
  /** Opens this task's card (the others fold to one line). */
  open: (taskId: string) => Promise<void>
  toggleShared: () => Promise<void>
  /** Makes an earlier checklist in this folder (one from VS Code, or another chat's) this chat's. */
  continueHere: (listId: string) => Promise<void>
  /** Shows or hides the ☾ Away time choices. */
  toggleAwayPicker: () => Promise<void>
  /** Draws the pane again (no change saved): what is typed is shown in full under its field. */
  redraw: () => void
}

export type View = {
  /** The task whose card is open, if the user picked one. */
  openId: string
  showShared: boolean
  /** Whether the ☾ Away time choices are showing. */
  awayPicker: boolean
  /** Cells across the pane's body. */
  width: number
  colors: Palette
}

/** openId for "no task card open": every task folds to one line. */
export const NONE_OPEN = '-'

const RANK: Record<string, number> = { urgent: 0, important: 1 }
const rank = (t: Task) => Math.min(...t.tags.map(x => RANK[x] ?? 2), 2)
/** Columns of a shared row's second line: the read status, then its button, then the note. */
const STATUS_WIDTH = 16
const ACTION_WIDTH = 16
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
/** A step's text without the "Step 2:" Claude sometimes writes, since the pane numbers steps itself. */
const stepText = (text: string) => text.replace(/^\s*step\s*\d+\s*[:.)\-–]\s*/i, '') || text

/** "pasted" for one Paste screenshot saved, else the file's name. */
const shotName = (listId: string, img: Img) => {
  const name = (img.path ?? '').split(/[\\/]/).pop() ?? ''
  return name.startsWith(listId + '-') ? 'pasted' : name.length > 32 ? '…' + name.slice(-31) : name || 'saved'
}

/** The tasks in the order the panel shows them: Claude's order, urgent and important first unless the group is a sequence. */
function ordered(c: Checklist) {
  return groupsOf(c).map(g => {
    const seq = g.name && isSequence(c, g.name) ? sequenceOf(c, g.name) : []
    const tasks = seq.length ? g.tasks : [...g.tasks].sort((a, b) => rank(a) - rank(b))
    return { ...g, tasks, seq }
  })
}

export function drawPane(els: Elements[keyof Elements], app: App, sid: string, view: View, act: Actions): RenderElement {
  const { Box, Text, Button } = els
  // The phone app has no text fields: there the pane shows the list with its buttons only.
  const Input = 'Input' in els ? els.Input : undefined
  const P = view.colors
  const width = Math.max(30, Math.min(view.width - 2, 110))
  const BADGE: Record<string, string> = { urgent: P.red, important: P.amber, blocked: P.violet }

  /* ------------------------------------------------------------------ small parts */

  /** A word on a coloured background: tags, NEXT, AWAY. */
  const badge = (label: string, bg: string) => (
    <Text backgroundColor={bg} color={P.onFill} bold>
      {` ${label} `}
    </Text>
  )
  /**
   * Keeps its own width in a row. In a narrow pane only the words wrap (titles, details); marks, ids, labels,
   * badges and buttons stay whole instead of each wrapping in its own column.
   */
  const keep = (child: RenderElement | string) => <Box flexShrink={0}>{child}</Box>
  /** A grey pill: counts. */
  const pill = (label: string | number) => (
    <Text backgroundColor={P.pillBg} color={P.pillFg}>
      {` ${label} `}
    </Text>
  )
  /** A key cap, for the key bar. */
  const key = (k: string, what: string) => (
    <Text>
      <Text backgroundColor={P.keyBg} color={P.keyFg} bold>
        {` ${k} `}
      </Text>
      <Text color={P.dim}>{` ${what}`}</Text>
    </Text>
  )
  /** A filled button; `hotkey` presses it while the pane has the keyboard (drawn "k:" before it). */
  const filled = (o: { key: string; label: string; bg: string; fg?: string; hotkey?: string; autoFocus?: boolean; onPress: (p: { surface: RenderSurface }) => void }) => (
    <Button key={o.key} label={o.label} plain hotkey={o.hotkey} autoFocus={o.autoFocus ? true : undefined} onPress={e => o.onPress(e)}>
      <Text backgroundColor={o.bg} color={o.fg ?? P.onFill} bold>
        {` ${o.label} `}
      </Text>
    </Button>
  )
  /** A quiet text button. */
  const quiet = (k: string, label: string, onPress: () => void, color = P.dim, hotkey?: string) => (
    <Button key={k} label={label} plain hotkey={hotkey} onPress={() => onPress()}>
      <Text color={color}>{label}</Text>
    </Button>
  )
  const tagBadges = (list: string[]) =>
    list.map(x =>
      BADGE[x] ? (
        <Text>
          {' '}
          {badge(x.toUpperCase(), BADGE[x])}
        </Text>
      ) : (
        <Text color={P.muted}>{` ${x}`}</Text>
      ),
    )
  /** A section header: the word, a count pill, a rule across the rest of the pane. */
  const section = (label: string, count: number, color: string, extra = '', toggle?: { key: string; open: boolean; onPress: () => void }) => {
    const used = label.length + String(count).length + 4 + extra.length + (toggle ? 2 : 0)
    const head = (
      <Text>
        {toggle ? <Text color={P.green} bold>{toggle.open ? '▾ ' : '▸ '}</Text> : ''}
        <Text color={color} bold>
          {label}
        </Text>
      </Text>
    )
    return (
      <Box flexDirection="row" marginTop={1}>
        {keep(
          toggle ? (
            <Button key={toggle.key} label={label} plain onPress={() => toggle.onPress()}>
              {head}
            </Button>
          ) : (
            head
          ),
        )}
        {keep(
          <Text>
            {' '}
            {pill(count)}
          </Text>,
        )}
        <Text wrap="truncate-end">
          <Text color={P.dim}>{extra}</Text>
          {width - used >= 2 ? <Text color={P.rule}>{` ${'─'.repeat(width - used)}`}</Text> : ''}
        </Text>
      </Box>
    )
  }
  /** A one-line framed text field: its label, the entry, and the field's own ⏎ action at the edge. */
  /**
   * A typed-text field: one line, and one more for each line typed with shift+Enter, up to 5 (more scroll
   * inside). The field cuts a line at its edge instead of wrapping it, and Claude Code draws its keys
   * ("⏎ save · shift+⏎ new line") beside it, so a line longer than the room left (`overflows`) is also shown
   * whole, wrapped, under the field, redrawn as it is typed.
   */
  const rowsFor = (text: string) => Math.min(5, text.split('\n').length)
  const room = Math.max(8, width - 42) // the card's and the field's frames, the label, and the keys beside it
  const overflows = (text: string) => text.split('\n').some(l => l.length > room)
  const typing = (listId: string, itemId: string, field: 'note' | 'other', was: string) => (v: string) => {
    app.type(listId, itemId, field, v)
    if (overflows(v) || overflows(was) || rowsFor(v) !== rowsFor(was)) act.redraw()
  }
  const whole = (text: string) =>
    overflows(text) && (
      <Box paddingX={1}>
        <Text color={P.muted} wrap="wrap">
          {text}
        </Text>
      </Box>
    )

  const field = (label: string, input: RenderElement) => (
    <Box flexDirection="row" borderStyle="round" borderColor={P.fieldBorder} paddingX={1} gap={2}>
      {keep(<Text color={P.muted}>{label}</Text>)}
      <Box flexGrow={1} flexShrink={1}>
        {input}
      </Box>
    </Box>
  )

  /* ------------------------------------------------------------------ nothing to show */

  if (!app.isOn)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={P.title}>
          Checklists are in the VS Code extension now
        </Text>
        <Text color={P.dim}>To use them here again, type /checklist use-mod.</Text>
      </Box>
    )

  const c = app.current(sid)
  if (!c) {
    // Checklists VS Code handed over, and other chats' open ones: one press makes one this chat's.
    const earlier = app.others(sid).slice(0, 5)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={P.title}>
          No checklist in this chat yet
        </Text>
        <Text color={P.dim}>When Claude needs you to do something by hand or make a decision, it shows up here.</Text>
        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={P.text}>{earlier.length === 1 ? 'Pick up the checklist from this folder:' : 'Pick up a checklist from this folder:'}</Text>
            {earlier.map((o, i) => {
              const left = o.tasks.filter(t => !t.shared).length + o.questions.filter(q => !q.answer && !q.retired).length
              return (
                <Box flexDirection="row" columnGap={2} marginTop={1}>
                  <Box flexShrink={0}>
                    {filled({
                      key: `continue-${o.id}`,
                      label: 'Continue here',
                      bg: P.cyan,
                      hotkey: String(i + 1),
                      autoFocus: i === 0,
                      onPress: () => act.continueHere(o.id),
                    })}
                  </Box>
                  <Text>
                    <Text bold color={P.title}>
                      {o.title}
                    </Text>
                    <Text color={P.dim}>{`  ${left} waiting on you`}</Text>
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  }

  /* ------------------------------------------------------------------ the checklist */

  const edit = (change: () => string | void) => act.edit(c.id, change)
  const groups = ordered(c)
  const all = groups.flatMap(g => g.tasks)
  const open = all.filter(t => !t.shared)
  const shared = all.filter(t => t.shared)
  const questions = c.questions.filter(q => !q.retired)
  const asking = questions.filter(q => !q.answer)
  const answered = questions.filter(q => q.answer)
  const current = open[0]
  const openTask = view.openId === NONE_OPEN ? undefined : (open.find(t => t.id === view.openId) ?? current)
  const unsent = app.store.updateSummary(c, 'line').ids.length
  const taskSeen = (t: Task) => !!t.seenAt && t.seenAt >= t.shared!.at
  const answerSeen = (q: Question) => !!q.seenAt && q.seenAt >= q.answer!.at
  // Handed over with Send now and not read yet: the "✓ Sent to Claude" line says so.
  const waitingRead = shared.filter(t => t.pushedAt && !taskSeen(t)).length + answered.filter(q => q.pushedAt && !answerSeen(q)).length
  const away = app.store.isAway(c)

  // The grid every list row follows: mark (3) · id (padded to the longest id) · " │ " · text.
  const idWidth = Math.max(2, ...all.map(t => t.id.length), ...questions.map(q => q.id.length))
  const idCell = (id: string) => (
    <Text>
      <Text color={P.muted}>{id.padEnd(idWidth)}</Text>
      <Text color={P.rule}>{' │ '}</Text>
    </Text>
  )
  const indent = (
    <Text>
      {' '.repeat(3 + idWidth)}
      <Text color={P.rule}>{' │ '}</Text>
    </Text>
  )
  const fixed = (w: number, child: RenderElement) => (
    <Box width={w} flexShrink={0}>
      {child}
    </Box>
  )

  const shots = (owner: Task | Question, imgs: Img[]) =>
    imgs.map((img, i) => (
      <Box flexDirection="row" gap={2}>
        <Text wrap="truncate-middle">
          <Text color={P.cyan}>▣ </Text>
          <Text>{`Screenshot ${i + 1}`}</Text>
          <Text color={P.muted}>{`  ${shotName(c.id, img)}`}</Text>
        </Text>
        {keep(quiet(`${owner.id}-rm-${img.id}`, 'remove', () => edit(() => void app.store.removeImage(c.id, owner.id, img.id))))}
      </Box>
    ))

  /** The note field, screenshots and the paste row under an open task or question. */
  const extras = (owner: Task | Question, note: string, setNote: (v: string) => void, imgs: Img[], withShots: boolean, space = true) => (
    <Box flexDirection="column" marginTop={space ? 1 : 0}>
      {Input &&
        field(
          'Note',
          <Input
            key={`${owner.id}-note`}
            placeholder="optional: what you did, or a value Claude needs"
            value={note}
            rows={rowsFor(note)}
            submitLabel="save"
            onInput={setNote}
            onSubmit={v => edit(() => setNote(v))}
          />,
        )}
      {Input && whole(note)}
      {shots(owner, imgs)}
      {withShots && imgs.length < 8 && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {keep(<Text color={P.muted}>Screenshot</Text>)}
          {keep(filled({ key: `${owner.id}-paste`, label: 'Paste from clipboard', bg: P.btnBg, fg: P.text, hotkey: 'v', onPress: () => act.paste(c, owner.id) }))}
          {Input && (
            <Box flexGrow={1} minWidth={20}>
              <Input
                key={`${owner.id}-shot`}
                placeholder="or type a file path"
                submitLabel="add"
                onSubmit={v => {
                  // Checked as the files are now: it may have been shared, or filled, from another chat meanwhile.
                  if (v.trim())
                    void edit(() => app.refusal(c.id, sid, owner.id) ?? (app.addShot(c.id, owner.id, v) ? undefined : 'That is not a .png, .jpg, .gif or .webp file.'))
                }}
              />
            </Box>
          )}
        </Box>
      )}
    </Box>
  )

  const taskCard = (t: Task, step?: { n: number; of: number }) => {
    const urgent = rank(t) === 0
    const isNext = t === current
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={urgent ? P.urgentBorder : P.nextBorder}
        paddingX={1}
        marginTop={1}
      >
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text>
            {isNext ? badge('NEXT', urgent ? P.red : P.cyan) : badge('OPEN', P.pillBg)}
            {step ? <Text color={P.dim}>{`  step ${step.n} of ${step.of}`}</Text> : ''}
            {tagBadges(t.tags)}
          </Text>
          <Box flexDirection="row" gap={2} flexShrink={0}>
            {quiet(`${t.id}-collapse`, 'collapse', () => act.open(NONE_OPEN))}
            <Text color={P.muted}>{`[${t.id}]`}</Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text bold color={P.title}>
            {step ? stepText(t.text) : t.text}
          </Text>
        </Box>
        {t.detail ? <Text color={P.dim}>{t.detail}</Text> : ''}
        {t.command && (
          <Box flexDirection="row" justifyContent="space-between" backgroundColor={P.wellBg} paddingX={1} marginTop={1}>
            <Text mono>
              <Text color={P.muted}>$ </Text>
              <Text color={P.green}>{t.command}</Text>
            </Text>
            {keep(
              <Button key={`${t.id}-copy`} label="copy" plain hotkey="c" onPress={e => act.copy(t.command!, e.surface)}>
                <Text color={P.dim}>copy</Text>
              </Button>,
            )}
          </Box>
        )}
        {extras(t, t.draft.note, typing(c.id, t.id, 'note', t.draft.note), t.draft.images, true)}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {filled({
            key: `${t.id}-share-done`,
            label: '✓ Done, share with Claude',
            bg: P.green,
            hotkey: 'd',
            autoFocus: true,
            onPress: () =>
              edit(() => {
                app.store.setDraft(c.id, t.id, { done: true })
                app.store.share(c.id, t.id)
              }),
          })}
          {filled({
            key: `${t.id}-share-notdone`,
            label: "✗ Couldn't do it",
            bg: P.notDoneBg,
            fg: P.red,
            hotkey: 'n',
            onPress: () =>
              edit(() => {
                app.store.setDraft(c.id, t.id, { done: false })
                app.store.share(c.id, t.id)
              }),
          })}
        </Box>
      </Box>
    )
  }

  const taskLine = (t: Task, step?: { n: number; of: number }) => {
    const urgent = rank(t) === 0
    const isNext = t === current
    const started = !!(t.draft.note || t.draft.images.length)
    return (
      <Box flexDirection="row">
        {keep(
          <Text>
            <Text color={urgent ? P.red : isNext ? P.cyan : P.muted}>{urgent ? ' ! ' : isNext ? ' ▸ ' : ' • '}</Text>
            {idCell(t.id)}
            {step ? <Text color={P.cyan}>{`${String(step.n).padStart(String(step.of).length)}. `}</Text> : ''}
          </Text>,
        )}
        <Box flexShrink={1}>
          <Button key={`${t.id}-open`} label={step ? stepText(t.text) : t.text} plain onPress={() => act.open(t.id)}>
            <Text color={P.text} bold={isNext}>
              {step ? stepText(t.text) : t.text}
            </Text>
          </Button>
        </Box>
        {keep(
          <Text>
            {started ? <Text color={P.cyan}> · draft</Text> : ''}
            {tagBadges(t.tags)}
            {isNext && view.openId === NONE_OPEN ? <Text color={P.cyan}>  next</Text> : ''}
          </Text>,
        )}
      </Box>
    )
  }

  const questionCard = (q: Question, first: boolean) => {
    const picks = q.draft.picks
    const urgent = q.tags.includes('urgent')
    const recommended = q.options.find(o => o.id === q.recommended)
    const labelWidth = Math.min(28, Math.max(...q.options.map(o => o.label.length)) + 2)
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={urgent ? P.urgentBorder : P.decideBorder}
        paddingX={1}
        marginTop={1}
      >
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold color={P.title}>
            {q.question}
          </Text>
          {keep(
            <Text>
              {q.tags.length ? <Text>{tagBadges(q.tags)}</Text> : ''}
              <Text color={P.muted}>{`  [${q.id}]`}</Text>
            </Text>,
          )}
        </Box>
        {q.why ? <Text color={P.dim}>{q.why}</Text> : ''}
        <Box flexDirection="column" marginTop={1}>
          {q.options.map((o, i) => {
            const on = picks.includes(o.id)
            const mark = q.multi ? (on ? '■' : '□') : on ? '●' : '○'
            return (
              <Box flexDirection="row">
                {keep(
                  <Button
                    key={`${q.id}-opt-${o.id}`}
                    label={o.label}
                    plain
                    hotkey={first && i < 9 ? String(i + 1) : undefined}
                    onPress={() =>
                      edit(() => {
                        // The picks as they are now, after reading the latest from disk.
                        const now = app.store.get(c.id)?.questions.find(x => x.id === q.id)?.draft.picks ?? []
                        const has = now.includes(o.id)
                        app.store.setAnswerDraft(c.id, q.id, { picks: q.multi ? (has ? now.filter(p => p !== o.id) : [...now, o.id]) : [o.id] })
                      })
                    }
                  >
                    <Text color={on ? P.cyan : P.text} bold={on}>
                      {`${mark} ${o.label.padEnd(labelWidth)}`}
                    </Text>
                  </Button>,
                )}
                {o.summary || o.details ? <Text color={P.dim}>{o.summary ?? o.details}</Text> : ''}
                {o === recommended ? keep(<Text color={P.green}>{'   ★ recommended'}</Text>) : ''}
              </Box>
            )
          })}
        </Box>
        {recommended && q.reason ? (
          <Text>
            <Text color={P.green}>★ </Text>
            <Text color={P.dim}>{q.reason}</Text>
          </Text>
        ) : (
          ''
        )}
        {Input && q.allowOther && (
          <Box flexDirection="column" marginTop={1}>
            {field(
              'Something else',
              <Input
                key={`${q.id}-other`}
                placeholder="your own answer"
                value={q.draft.other}
                rows={rowsFor(q.draft.other)}
                submitLabel="save"
                onInput={typing(c.id, q.id, 'other', q.draft.other)}
                onSubmit={v => edit(() => void app.store.setAnswerDraft(c.id, q.id, { other: v }))}
              />,
            )}
            {whole(q.draft.other)}
          </Box>
        )}
        {extras(q, q.draft.note, typing(c.id, q.id, 'note', q.draft.note), q.draft.images, false, !(Input && q.allowOther))}
        <Box marginTop={1}>
          {filled({
            key: `${q.id}-answer`,
            label: `✓ Answer ${q.id}`,
            bg: P.amber,
            onPress: () => edit(() => (app.store.shareAnswer(c.id, q.id) ? undefined : `Pick an option for ${q.id} first.`)),
          })}
        </Box>
      </Box>
    )
  }

  const readMark = (seen: boolean, pushed: boolean) =>
    seen ? <Text color={P.green}>◉ read</Text> : pushed ? <Text color={P.dim}>◌ sent</Text> : <Text color={P.dim}>◌ not read yet</Text>

  /** One shared task or answer on the grid: what it was, then its status, button and note in fixed columns. */
  const sharedRow = (o: { id: string; mark: RenderElement; title: RenderElement; seen: boolean; pushed: boolean; note?: string; shots?: number; button: RenderElement }) => (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        {o.mark}
        {idCell(o.id)}
        {o.title}
      </Box>
      <Box flexDirection="row">
        {indent}
        {fixed(STATUS_WIDTH, readMark(o.seen, o.pushed))}
        {fixed(ACTION_WIDTH, o.button)}
        <Text>
          {o.note ? <Text color={P.dim}>{`“${o.note}”`}</Text> : ''}
          {o.note && o.shots ? '  ' : ''}
          {o.shots ? <Text color={P.cyan}>{`▣ ${o.shots}`}</Text> : ''}
        </Text>
      </Box>
    </Box>
  )

  const sharedRows = () => (
    <Box flexDirection="column" marginTop={1}>
      {answered.map(q => {
        const a = q.answer!
        const choice = [...q.options.filter(o => a.picks.includes(o.id)).map(o => o.label), ...(a.other ? [a.other] : [])].join(', ')
        return sharedRow({
          id: q.id,
          mark: (
            <Text color={P.green} bold>
              {' ✓ '}
            </Text>
          ),
          title: (
            <Text>
              <Text color={P.dim}>{`${q.question}  `}</Text>
              <Text bold color={P.text}>
                {choice}
              </Text>
            </Text>
          ),
          seen: answerSeen(q),
          pushed: !!q.pushedAt,
          note: a.note,
          shots: a.images.length,
          button: quiet(`${q.id}-change`, 'Change answer', () => edit(() => void app.store.unshareAnswer(c.id, q.id))),
        })
      })}
      {shared.map(t => {
        const s = t.shared!
        return sharedRow({
          id: t.id,
          mark: (
            <Text color={s.done ? P.green : P.red} bold>
              {s.done ? ' ✓ ' : ' ✗ '}
            </Text>
          ),
          title: (
            <Text>
              <Text color={P.dim}>{t.text}</Text>
              {!s.done ? <Text color={P.amber}>  not done</Text> : ''}
            </Text>
          ),
          seen: taskSeen(t),
          pushed: !!t.pushedAt,
          note: s.note,
          shots: s.images.length,
          button: quiet(`${t.id}-unshare`, 'Take back', () => edit(() => void app.store.unshare(c.id, t.id))),
        })
      })}
    </Box>
  )

  /* ------------------------------------------------------------------ header */

  const total = all.length + questions.length
  const doneCount = shared.filter(t => t.shared!.done).length + answered.length
  const notDone = shared.length - shared.filter(t => t.shared!.done).length
  const finished = shared.length + answered.length
  const barWidth = Math.max(10, Math.min(width - c.title.length - 12, 22))
  const cells = (n: number) => (total ? Math.round((n / total) * barWidth) : 0)
  const need = [asking.length && plural(asking.length, 'decision'), open.length && plural(open.length, 'task')].filter(Boolean).join(' · ')
  const readCount = shared.filter(taskSeen).length + answered.filter(answerSeen).length

  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={P.title}>
          {c.title}
        </Text>
        <Text>
          <Text color={P.dim}>{`${finished}/${total} `}</Text>
          <Text color={P.green}>{'━'.repeat(cells(doneCount))}</Text>
          <Text color={P.amber}>{'━'.repeat(cells(notDone))}</Text>
          <Text color={P.track}>{'─'.repeat(Math.max(0, barWidth - cells(doneCount) - cells(notDone)))}</Text>
        </Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text color={P.dim}>{need ? `${need} waiting on you` : 'Nothing waiting on you'}</Text>
        <Box flexDirection="row" gap={2}>
          {!away && filled({ key: 'away', label: '☾ Away', bg: view.awayPicker ? P.amber : P.btnBg, fg: view.awayPicker ? P.onFill : P.amber, hotkey: 'a', onPress: () => act.toggleAwayPicker() })}
          {unsent > 0 && filled({ key: 'send', label: `➤ Send ${plural(unsent, 'update')}`, bg: P.cyan, hotkey: 's', onPress: () => act.send(c) })}
        </Box>
      </Box>
    </Box>
  )

  const awayPicker = !away && view.awayPicker && (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={P.awayBorder} paddingX={1}>
      <Text>
        <Text bold color={P.title}>
          Going away?
        </Text>
        <Text color={P.dim}> Claude won't wait for you. It does what it safely can and leaves the rest here.</Text>
      </Text>
      <Box flexDirection="row" gap={2} marginTop={1} flexWrap="wrap">
        <Text color={P.muted}>Away for</Text>
        {AWAY_CHOICES.map(o =>
          filled({
            key: `away-${o.ms}`,
            label: o.label,
            bg: P.awayTrack,
            fg: P.amber,
            onPress: async () => {
              await act.toggleAwayPicker()
              await edit(() => {
                const a = awayFor(o.ms)
                if (!a || !app.store.setAway(c.id, a.ms, a.label, a.midnightIn)) return 'Could not set the time.'
              })
            },
          }),
        )}
        {quiet('away-cancel', 'cancel', () => act.toggleAwayPicker())}
      </Box>
      <Text color={P.muted}>Or type /checklist away 18:30 for a time of your own.</Text>
    </Box>
  )

  const leftMs = Math.max(0, (c.awayUntil ?? Date.now()) - Date.now())
  const awayTrack = Math.max(10, width - 6)
  const awayGone = c.awayMs ? Math.round(((c.awayMs - leftMs) / c.awayMs) * awayTrack) : 0
  const awayCard = away && (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={P.awayBorder} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {badge('☾ AWAY', P.amber)}
          <Text bold color={P.title}>{`  until ${awayDay(c)}${c.awayLabel ?? 'later'}`}</Text>
        </Text>
        <Text bold color={P.amber}>{`${leftText(leftMs)} left`}</Text>
      </Box>
      <Text color={P.dim}>Claude won't wait for you. It does what it safely can and leaves the rest here.</Text>
      <Text>
        <Text color={P.amber}>{'━'.repeat(Math.max(0, awayTrack - awayGone))}</Text>
        <Text color={P.awayTrack}>{'━'.repeat(Math.max(0, awayGone))}</Text>
      </Text>
      <Box flexDirection="row" gap={2} marginTop={1}>
        {filled({
          key: 'away-more',
          label: '+30 min',
          bg: P.awayTrack,
          fg: P.amber,
          onPress: () =>
            edit(() => {
              const until = app.store.get(c.id)?.awayUntil ?? Date.now()
              const a = awayFor(Math.min(Math.max(0, until - Date.now()) + EXTEND_MS, MAX_AWAY_MS))
              if (!a || !app.store.setAway(c.id, a.ms, a.label, a.midnightIn)) return 'You can be away for up to 24 hours.'
            }),
        })}
        {filled({
          key: 'back',
          label: "I'm back",
          bg: P.amber,
          hotkey: 'b',
          onPress: () => edit(() => void app.store.endAway(c.id)),
        })}
      </Box>
    </Box>
  )

  const sentLine = unsent === 0 && waitingRead > 0 && (
    <Box flexDirection="row" marginTop={1} borderStyle="round" borderColor={P.sentBorder} paddingX={1}>
      <Text>
        <Text bold color={P.green}>
          ✓ Sent to Claude
        </Text>
        <Text color={P.dim}>{`  ${plural(waitingRead, 'update')} · it reads them when it next runs`}</Text>
      </Text>
    </Box>
  )

  const keyBar = Input && (
    <Box flexDirection="column" marginTop={1}>
      <Text color={P.rule}>{'─'.repeat(width)}</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {openTask && key('d', 'done')}
        {openTask && key('n', "couldn't")}
        {openTask && key('v', 'paste')}
        {openTask?.command && key('c', 'copy')}
        {asking.length > 0 && key('1-9', 'pick')}
        {away ? key('b', "I'm back") : key('a', 'away')}
        {unsent > 0 && key('s', 'send')}
        <Text color={P.muted}>ctrl+x tab to focus</Text>
      </Box>
    </Box>
  )

  /* ------------------------------------------------------------------ the pane */

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {awayPicker}
      {awayCard}
      {sentLine}

      {!open.length && !asking.length && (
        <Box marginTop={1}>
          <Text>
            {badge('ALL DONE', P.green)}
            <Text color={P.text}>  Claude has everything it asked for.</Text>
          </Text>
        </Box>
      )}

      {asking.length > 0 && (
        <Box flexDirection="column">
          {section('DECIDE', asking.length, P.amber)}
          {asking.map((q, i) => questionCard(q, i === 0))}
        </Box>
      )}

      {open.length > 0 && (
        <Box flexDirection="column">
          {section('TO DO', open.length, P.cyan, openTask ? '' : '   all folded · press one to open it')}
          {groups
            .filter(g => g.tasks.some(t => !t.shared))
            .map(g => {
              const left = g.tasks.filter(t => !t.shared)
              const how = g.phase ? `phase ${g.phase} of ${g.phases} · in order` : g.seq.length ? 'in order' : ''
              return (
                <Box flexDirection="column" marginTop={1}>
                  {g.name && (
                    <Text>
                      <Text bold color={P.text}>
                        {g.name}
                      </Text>
                      {how ? <Text color={P.muted}>{`  ${how}`}</Text> : ''}
                    </Text>
                  )}
                  {left.map(t => {
                    const step = g.seq.length ? { n: g.seq.indexOf(t) + 1, of: g.seq.length } : undefined
                    return t === openTask ? taskCard(t, step) : taskLine(t, step)
                  })}
                </Box>
              )
            })}
        </Box>
      )}

      {finished > 0 && (
        <Box flexDirection="column">
          {section('SHARED WITH CLAUDE', finished, P.green, `   ${readCount} read${notDone ? ` · ${notDone} not done` : ''}`, {
            key: 'shared-toggle',
            open: view.showShared,
            onPress: () => act.toggleShared(),
          })}
          {view.showShared && sharedRows()}
        </Box>
      )}

      {keyBar}
    </Box>
  )
}
