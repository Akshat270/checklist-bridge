// The checklist pane, drawn with Claude Code's own elements: the same checklist as the VS Code panel,
// laid out for a terminal column. It follows DESIGN.md in terminal terms:
//
// - Colours come from the terminal theme's own names (suggestion, success, warning, error, subtle,
//   inverseText), never fixed hex, so light and dark themes both read well.
// - Every colour means one thing: suggestion (the accent) is "act here", success is shared as done,
//   warning is not done or "decide", error is urgent. Badges are a word on a coloured background.
// - Hierarchy is weight and dimming: bold for what needs you, dim for what is settled.
//
//   Title ............................. 4/10  ━━━━━━──────   header, then Send now when there is news
//   DECIDE  1                                                  question cards, options picked with 1–9
//   TO DO  5                                                   the next task as a card, the rest one line each
//   ▸ SHARED WITH CLAUDE  4                                    folded away; open it to take something back
//    d  done   n  couldn't do it   v  paste ...                the keys, as key caps
//
// No `$` here: register.tsx resolves the elements and passes in what a press should do.
import type { Elements, RenderElement } from 'claude-code'

import type { App } from './app'
import { AWAY_CHOICES, EXTEND_MS, awayFor, leftText } from './away'
import { awayDay, groupsOf, isSequence, MAX_AWAY_MS, sequenceOf, type Checklist, type Img, type Question, type Task } from './lib/model'

export type Actions = {
  /** Saves `c` and redraws. */
  changed: (c: Checklist) => Promise<void>
  toast: (text: string) => void
  /** Send now. */
  send: (c: Checklist) => Promise<void>
  /** Saves the image on the clipboard as a screenshot of this task or question. */
  paste: (c: Checklist, itemId: string) => Promise<void>
  /** Opens this task's card (the others fold to one line). */
  open: (taskId: string) => Promise<void>
  toggleShared: () => Promise<void>
  /** Shows or hides the ☾ Away time choices. */
  toggleAwayPicker: () => Promise<void>
}

export type View = {
  /** The task whose card is open, if the user picked one. */
  openId: string
  showShared: boolean
  /** Whether the ☾ Away time choices are showing. */
  awayPicker: boolean
  /** Cells across the pane, for the progress bar. */
  width: number
}

/**
 * The pane's own colours, in one place (named ANSI colours, lazygit style). They are picked for a dark
 * terminal; everything else uses the theme's colour names so it follows the user's theme.
 */
const COLOR = {
  next: 'cyan', // the NEXT badge, and the marker of the next task in the list
  title: 'white', // the open task's title, and field labels
  muted: 'gray', // instructions ("Run this:"), the list's │ divider
  number: 'cyan', // step numbers in lists
  command: 'green', // a command to run
  done: 'green', // the primary "Done, share" button
  notDone: 'red', // "Couldn't do it"
} as const

/** openId for "no task card open": every task folds to one line. */
export const NONE_OPEN = '-'

const RANK: Record<string, number> = { urgent: 0, important: 1 }
const rank = (t: Task) => Math.min(...t.tags.map(x => RANK[x] ?? 2), 2)
/** Tags that get a coloured badge; any other tag is drawn as plain dim text. */
const BADGE: Record<string, string> = { urgent: 'error', important: 'warning', blocked: 'permission' }
/** Columns of a shared row's second line: the read status, then its button, then the note. */
const STATUS_WIDTH = 18
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
  const barWidth = Math.max(10, Math.min(view.width - 30, 24))

  /** A word on a coloured background: tags, NEXT, AWAY. */
  const badge = (label: string, color: string, ink = 'inverseText') => (
    <Text backgroundColor={color} color={ink} bold>
      {` ${label} `}
    </Text>
  )
  /** A small grey pill: counts and key caps. */
  const pill = (label: string | number) => (
    <Text backgroundColor="subtle" color="inverseText">
      {` ${label} `}
    </Text>
  )
  /** Tag badges, each after a space, or with none before the first when `lead` is false. */
  const tagBadges = (list: string[], lead = true) =>
    list.map((x, i) => {
      const gap = lead || i ? ' ' : ''
      return BADGE[x] ? (
        <Text>
          {gap}
          {badge(x.toUpperCase(), BADGE[x])}
        </Text>
      ) : (
        <Text dimColor>
          {gap}
          {x}
        </Text>
      )
    })
  const heading = (label: string, count: number, color?: string) => (
    <Box flexDirection="row" gap={1} marginTop={1}>
      <Text bold color={color}>
        {label}
      </Text>
      {pill(count)}
    </Box>
  )

  /** A labelled text field: the label above, the entry area in a light frame (its ⏎ action sits at the frame's right edge). */
  const field = (label: string, input: RenderElement) => (
    <Box flexDirection="column">
      <Text color={COLOR.title}>{label}</Text>
      <Box borderStyle="round" borderColor="subtle" paddingX={1}>
        {input}
      </Box>
    </Box>
  )

  if (!app.isOn)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Checklists are in the VS Code extension now.</Text>
        <Text dimColor>To use them here again, type /checklist use-mod.</Text>
      </Box>
    )

  const c = app.current(sid)
  if (!c)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>No checklist in this chat yet</Text>
        <Text dimColor>When Claude needs you to do something by hand or make a decision, it shows up here.</Text>
        {app.others(sid).length > 0 && (
          <Text>
            <Text dimColor>To pick up an earlier one, type </Text>/checklist list
          </Text>
        )}
      </Box>
    )

  const save = () => act.changed(c)
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

  // The grid every list row follows:  mark (3) · id (padded to the longest id) · " │ " · text.
  // Ids lead, so the text of every row starts in the same column whatever its id or step number.
  const idWidth = Math.max(2, ...all.map(t => t.id.length), ...questions.map(q => q.id.length))
  const idCell = (id: string) => (
    <Text>
      <Text dimColor>{id.padEnd(idWidth)}</Text>
      <Text color={COLOR.muted}>{' │ '}</Text>
    </Text>
  )
  /** The same columns with no mark and no id: where a row's second line starts. */
  const indent = (
    <Text>
      {' '.repeat(3 + idWidth)}
      <Text color={COLOR.muted}>{' │ '}</Text>
    </Text>
  )
  /** A fixed-width cell, so the cells after it start in the same column on every row. */
  const fixed = (width: number, child: RenderElement) => (
    <Box width={width} flexShrink={0}>
      {child}
    </Box>
  )

  const shots = (owner: Task | Question, imgs: Img[]) =>
    imgs.map((img, i) => (
      <Box flexDirection="row" gap={1}>
        <Text color="success">▣</Text>
        <Text>
          Screenshot {i + 1} <Text dimColor>{shotName(c.id, img)}</Text>
        </Text>
        <Button
          key={`${owner.id}-rm-${img.id}`}
          label="Remove"
          plain
          dimColor
          onPress={async () => {
            app.store.removeImage(c.id, owner.id, img.id)
            await save()
          }}
        />
      </Box>
    ))

  /** The note box and screenshots under an open task or question. */
  const extras = (owner: Task | Question, note: string, setNote: (v: string) => void, imgs: Img[], withShots: boolean) => (
    <Box flexDirection="column" marginTop={1}>
      {Input &&
        field(
          'Note for Claude',
          <Input
            key={`${owner.id}-note`}
            placeholder="optional: what you did, or a value Claude needs"
            value={note}
            submitLabel="Save"
            onInput={setNote}
            onSubmit={async v => {
              setNote(v)
              await save()
            }}
          />,
        )}
      {shots(owner, imgs)}
      {withShots && imgs.length < 8 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Screenshot</Text>
          <Box flexDirection="row" gap={2}>
            <Button key={`${owner.id}-paste`} label="Paste from clipboard" variant="secondary" hotkey="v" onPress={() => act.paste(c, owner.id)} />
            {Input && (
              <Input
                key={`${owner.id}-shot`}
                placeholder="or type an image file's path"
                submitLabel="Add"
                onSubmit={async v => {
                  if (!v.trim()) return
                  if (!app.store.addImagePath(c.id, owner.id, v)) return act.toast('That is not a .png, .jpg, .gif or .webp file.')
                  await save()
                }}
              />
            )}
          </Box>
        </Box>
      )}
    </Box>
  )

  const taskCard = (t: Task, step?: { n: number; of: number }) => {
    const urgent = rank(t) === 0
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={urgent ? 'error' : 'suggestion'} paddingX={1} marginTop={1}>
        {/* Badges, then a blank line, then the title with its description under it in grey. */}
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text>
            {t === current ? badge('NEXT', COLOR.next, 'black') : badge('OPEN', 'subtle')}
            {step && <Text dimColor>{`  step ${step.n} of ${step.of}`}</Text>}
            {tagBadges(t.tags)}
          </Text>
          <Box flexDirection="row" gap={2}>
            <Button key={`${t.id}-collapse`} label="Collapse" plain dimColor onPress={() => act.open(NONE_OPEN)} />
            <Text dimColor>{`[${t.id}]`}</Text>
          </Box>
        </Box>
        <Text bold color={COLOR.title}>
          {step ? stepText(t.text) : t.text}
        </Text>
        {t.detail && (
          <Box marginTop={1}>
            <Text color="inactive">{t.detail}</Text>
          </Box>
        )}
        {t.command && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={COLOR.muted}>Run this:</Text>
            <Box paddingLeft={2}>
              <Text mono color={COLOR.command}>{`$ ${t.command}`}</Text>
            </Box>
          </Box>
        )}
        {extras(t, t.draft.note, v => app.store.setDraft(c.id, t.id, { note: v }), t.draft.images, true)}
        {/* One empty line between the fields and the actions. */}
        <Box flexDirection="row" gap={2} marginTop={1} marginBottom={0}>
          <Button
            key={`${t.id}-share-done`}
            label="Done, share with Claude"
            plain
            hotkey="d"
            autoFocus
            onPress={async () => {
              app.store.setDraft(c.id, t.id, { done: true })
              app.store.share(c.id, t.id)
              await save()
            }}
          >
            <Text backgroundColor={COLOR.done} color="black" bold>
              {' ✓ Done, share with Claude '}
            </Text>
          </Button>
          <Button
            key={`${t.id}-share-notdone`}
            label="Couldn't do it"
            plain
            hotkey="n"
            onPress={async () => {
              app.store.setDraft(c.id, t.id, { done: false })
              app.store.share(c.id, t.id)
              await save()
            }}
          >
            <Text color={COLOR.notDone}>✗ Couldn't do it</Text>
          </Button>
        </Box>
      </Box>
    )
  }

  const taskLine = (t: Task, step?: { n: number; of: number }) => {
    const urgent = rank(t) === 0
    const started = !!(t.draft.note || t.draft.images.length)
    return (
      <Box flexDirection="row">
        <Text color={urgent ? 'error' : t === current ? COLOR.next : undefined} dimColor={!urgent && t !== current}>
          {urgent ? ' ! ' : t === current ? ' ▸ ' : ' • '}
        </Text>
        {idCell(t.id)}
        {step ? <Text color={COLOR.number}>{`${String(step.n).padStart(String(step.of).length)}. `}</Text> : ''}
        {/* Only the text is the button: the pointer inverts a button, and this keeps that to the text. */}
        <Button key={`${t.id}-open`} label={step ? stepText(t.text) : t.text} plain onPress={() => act.open(t.id)} />
        <Text>
          {started ? <Text color="suggestion"> · draft</Text> : ''}
          {tagBadges(t.tags)}
        </Text>
      </Box>
    )
  }

  const questionCard = (q: Question, first: boolean) => {
    const picks = q.draft.picks
    const urgent = q.tags.includes('urgent')
    const recommended = q.options.find(o => o.id === q.recommended)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={urgent ? 'error' : 'warning'} paddingX={1} marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold>{q.question}</Text>
          <Text dimColor>{`[${q.id}]`}</Text>
        </Box>
        {q.tags.length > 0 && <Text>{tagBadges(q.tags, false)}</Text>}
        {q.why && (
          <Box marginTop={1}>
            <Text color="inactive">{q.why}</Text>
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{q.multi ? 'Pick one or more' : 'Pick one'}</Text>
          {q.options.map((o, i) => {
            const on = picks.includes(o.id)
            const mark = q.multi ? (on ? '■' : '□') : on ? '●' : '○'
            return (
              <Box flexDirection="row">
                {/* Only the choice is the button (the pointer inverts a button); its summary sits beside it. */}
                <Button
                  key={`${q.id}-opt-${o.id}`}
                  label={o.label}
                  plain
                  hotkey={first && i < 9 ? String(i + 1) : undefined}
                  onPress={async () => {
                    const next = q.multi ? (on ? picks.filter(p => p !== o.id) : [...picks, o.id]) : [o.id]
                    app.store.setAnswerDraft(c.id, q.id, { picks: next })
                    await save()
                  }}
                >
                  <Text color={on ? COLOR.next : undefined} dimColor={!on}>{`${mark} `}</Text>
                  <Text bold={on} color={on ? COLOR.next : undefined}>
                    {o.label}
                  </Text>
                </Button>
                <Text>
                  {o.summary || o.details ? <Text dimColor>{`  ${o.summary ?? o.details}`}</Text> : ''}
                  {o === recommended ? <Text color="success"> ★ recommended</Text> : ''}
                </Text>
              </Box>
            )
          })}
        </Box>
        {recommended && q.reason && (
          <Text dimColor>
            <Text color="success">★</Text> {q.reason}
          </Text>
        )}
        {Input && q.allowOther && (
          <Box flexDirection="column" marginTop={1}>
            {field(
              'Something else',
              <Input
                key={`${q.id}-other`}
                placeholder="your own answer"
                value={q.draft.other}
                submitLabel="Save"
                onInput={v => app.store.setAnswerDraft(c.id, q.id, { other: v })}
                onSubmit={async v => {
                  app.store.setAnswerDraft(c.id, q.id, { other: v })
                  await save()
                }}
              />,
            )}
          </Box>
        )}
        {extras(q, q.draft.note, v => app.store.setAnswerDraft(c.id, q.id, { note: v }), q.draft.images, false)}
        <Box marginTop={1}>
          <Button
            key={`${q.id}-answer`}
            label={`✓ Answer ${q.id}`}
            variant="primary"
            onPress={async () => {
              if (!app.store.shareAnswer(c.id, q.id)) return act.toast(`Pick an option for ${q.id} first.`)
              await save()
            }}
          />
        </Box>
      </Box>
    )
  }

  const readMark = (seen: boolean, pushed: boolean) =>
    seen ? <Text color="success">◉ read by Claude</Text> : pushed ? <Text dimColor>◌ sent</Text> : <Text dimColor>◌ not read yet</Text>

  /** One shared task or answer: what it was on the first line, its state and a quiet button under it. */
  const sharedRow = (o: {
    id: string
    mark: RenderElement
    title: RenderElement
    seen: boolean
    pushed: boolean
    note?: string
    shots?: number
    button: RenderElement
  }) => (
    <Box flexDirection="column" marginBottom={1}>
      {/* mark · id │ what it was */}
      <Box flexDirection="row">
        {o.mark}
        {idCell(o.id)}
        {o.title}
      </Box>
      {/* under the text column: status | action | note, each in its own fixed column */}
      <Box flexDirection="row">
        {indent}
        {fixed(STATUS_WIDTH, readMark(o.seen, o.pushed))}
        {fixed(ACTION_WIDTH, o.button)}
        <Text dimColor>
          {o.note ? `“${o.note}”` : ''}
          {o.note && o.shots ? '  ' : ''}
          {o.shots ? `▣ ${plural(o.shots, 'screenshot')}` : ''}
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
          mark: <Text color="success" bold>{' ✓ '}</Text>,
          title: (
            <Text>
              <Text dimColor>{`${q.question} `}</Text>
              <Text bold>{choice}</Text>
            </Text>
          ),
          seen: !!q.seenAt && q.seenAt >= a.at,
          pushed: !!q.pushedAt,
          note: a.note,
          shots: a.images.length,
          button: (
            <Button
              key={`${q.id}-change`}
              label="Change answer"
              plain
              dimColor
              onPress={async () => {
                app.store.unshareAnswer(c.id, q.id)
                await save()
              }}
            />
          ),
        })
      })}
      {shared.map(t => {
        const s = t.shared!
        return sharedRow({
          id: t.id,
          mark: (
            <Text color={s.done ? 'success' : 'warning'} bold>
              {s.done ? ' ✓ ' : ' ✗ '}
            </Text>
          ),
          title: (
            <Text>
              <Text dimColor>{t.text}</Text>
              {!s.done && <Text color="warning"> · not done</Text>}
            </Text>
          ),
          seen: !!t.seenAt && t.seenAt >= s.at,
          pushed: !!t.pushedAt,
          note: s.note,
          shots: s.images.length,
          button: (
            <Button
              key={`${t.id}-unshare`}
              label="Take back"
              plain
              dimColor
              onPress={async () => {
                app.store.unshare(c.id, t.id)
                await save()
              }}
            />
          ),
        })
      })}
    </Box>
  )

  const total = all.length + questions.length
  const doneCount = shared.filter(t => t.shared!.done).length + answered.length
  const notDone = shared.length - shared.filter(t => t.shared!.done).length
  const finished = shared.length + answered.length
  const cells = (n: number) => (total ? Math.round((n / total) * barWidth) : 0)
  const away = app.store.isAway(c)
  const need = [asking.length && plural(asking.length, 'decision'), open.length && plural(open.length, 'task')].filter(Boolean).join(' and ')

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header: title, progress, and what needs you */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{c.title}</Text>
        <Text>
          <Text dimColor>{`${finished}/${total}  `}</Text>
          <Text color="success">{'━'.repeat(cells(doneCount))}</Text>
          <Text color="warning">{'━'.repeat(cells(notDone))}</Text>
          <Text dimColor>{'─'.repeat(Math.max(0, barWidth - cells(doneCount) - cells(notDone)))}</Text>
        </Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>{need ? `${need[0]!.toUpperCase()}${need.slice(1)} waiting on you` : 'Nothing waiting on you'}</Text>
        {!away && (
          <Button key="away" label="☾ Away" plain dimColor={!view.awayPicker} hotkey="a" onPress={() => act.toggleAwayPicker()} />
        )}
      </Box>

      {/* ☾ Away: pick how long, and Claude stops waiting for you until then. */}
      {!away && view.awayPicker && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="warning" paddingX={1}>
          <Text>
            <Text bold>Going away?</Text>
            <Text dimColor> Claude won't wait for you. It does what it safely can and leaves the rest here.</Text>
          </Text>
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Text color={COLOR.muted}>Away for</Text>
            {AWAY_CHOICES.map(o => (
              <Button
                key={`away-${o.ms}`}
                label={o.label}
                variant="secondary"
                onPress={async () => {
                  const a = awayFor(o.ms)
                  if (!a || !app.store.setAway(c.id, a.ms, a.label, a.midnightIn)) return act.toast('Could not set the time.')
                  await act.toggleAwayPicker()
                  await save()
                }}
              />
            ))}
            <Button key="away-cancel" label="Cancel" plain dimColor onPress={() => act.toggleAwayPicker()} />
          </Box>
          <Text dimColor>Or type /checklist away 18:30 for a time of your own.</Text>
        </Box>
      )}

      {away && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {badge('☾ AWAY', 'warning')}
            <Text bold>{` until ${awayDay(c)}${c.awayLabel ?? 'later'}`}</Text>
            <Text dimColor>{`  ${leftText((c.awayUntil ?? Date.now()) - Date.now())} left · Claude won't wait for you`}</Text>
          </Text>
          <Box flexDirection="row" gap={2} paddingLeft={9}>
            <Button
              key="away-more"
              label="+30 min"
              variant="secondary"
              onPress={async () => {
                const a = awayFor(Math.min((c.awayUntil ?? Date.now()) - Date.now() + EXTEND_MS, MAX_AWAY_MS))
                if (!a || !app.store.setAway(c.id, a.ms, a.label, a.midnightIn)) return act.toast('You can be away for up to 24 hours.')
                await save()
              }}
            />
            <Button
              key="back"
              label="I'm back"
              variant="primary"
              onPress={async () => {
                app.store.endAway(c.id)
                await save()
              }}
            />
          </Box>
        </Box>
      )}

      {unsent > 0 && (
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="send" label={`➤ Send ${plural(unsent, 'update')} to Claude`} variant="primary" hotkey="s" onPress={() => act.send(c)} />
          <Text dimColor>or Claude reads them next time</Text>
        </Box>
      )}

      {!open.length && !asking.length && (
        <Box marginTop={1}>
          {badge('ALL DONE', 'success')}
          <Text> Claude has everything it asked for.</Text>
        </Box>
      )}

      {asking.length > 0 && (
        <Box flexDirection="column">
          {heading('DECIDE', asking.length, 'warning')}
          {asking.map((q, i) => questionCard(q, i === 0))}
        </Box>
      )}

      {open.length > 0 && (
        <Box flexDirection="column">
          {heading('TO DO', open.length, 'suggestion')}
          {groups
            .filter(g => g.tasks.some(t => !t.shared))
            .map(g => {
              const left = g.tasks.filter(t => !t.shared)
              const how = g.phase ? `phase ${g.phase} of ${g.phases} · in order` : g.seq.length ? 'in order' : ''
              return (
                <Box flexDirection="column" marginTop={1}>
                  {g.name && (
                    <Text>
                      <Text bold>{g.name}</Text>
                      {how ? <Text dimColor>{`  ${how}`}</Text> : ''}
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
        <Box flexDirection="column" marginTop={1}>
          <Button key="shared-toggle" plain onPress={() => act.toggleShared()}>
            <Text bold color="success">{view.showShared ? '▾ ' : '▸ '}</Text>
            <Text bold>SHARED WITH CLAUDE </Text>
            {pill(finished)}
            <Text dimColor>{view.showShared ? '' : '  open to see notes or take one back'}</Text>
          </Button>
          {view.showShared && sharedRows()}
        </Box>
      )}

      {Input && (open.length > 0 || asking.length > 0) && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          <Text>
            {pill('d')}
            <Text dimColor> done</Text>
          </Text>
          <Text>
            {pill('n')}
            <Text dimColor> couldn't</Text>
          </Text>
          <Text>
            {pill('v')}
            <Text dimColor> paste</Text>
          </Text>
          <Text>
            {pill('a')}
            <Text dimColor> away</Text>
          </Text>
          {asking.length > 0 && (
            <Text>
              {pill('1–9')}
              <Text dimColor> pick</Text>
            </Text>
          )}
          {unsent > 0 && (
            <Text>
              {pill('s')}
              <Text dimColor> send</Text>
            </Text>
          )}
          <Text dimColor>(Ctrl+X Tab to use keys)</Text>
        </Box>
      )}
    </Box>
  )
}
