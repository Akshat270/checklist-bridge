// The checklist pane, drawn with Claude Code's own elements: the same checklist as the VS Code panel,
// laid out for a terminal column (see DESIGN.md for the rules it follows).
//
//   Title, progress bar, "Send now"            what to do first is at the top
//   Decide        open questions, each a card   options are buttons, 1–9 pick in the first one
//   To do         one open card (the next task), every other task one line you can open
//   Shared with Claude (n)                      folded away; open it to take something back
//
// No `$` here: register.tsx resolves the elements and passes in what a press should do.
import type { Elements, RenderElement } from 'claude-code'

import type { App } from './app'
import { groupsOf, isSequence, sequenceOf, type Checklist, type Img, type Question, type Task } from './lib/model'

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
}

export type View = {
  /** The task whose card is open, if the user picked one. */
  openId: string
  showShared: boolean
  /** Cells across the pane, for rules and the progress bar. */
  width: number
}

const RANK: Record<string, number> = { urgent: 0, important: 1 }
const rank = (t: Task) => Math.min(...t.tags.map(x => RANK[x] ?? 2), 2)
const TAG_COLOR: Record<string, string> = { urgent: 'error', important: 'warning', quick: 'suggestion', blocked: 'permission' }
/** "pasted" for one Paste screenshot saved, else the file's name. */
const shotName = (listId: string, img: Img) => {
  const name = (img.path ?? '').split(/[\\/]/).pop() ?? ''
  return name.startsWith(listId + '-') ? 'pasted' : name.length > 32 ? '…' + name.slice(-31) : name || 'saved'
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The tasks in the order the panel shows them: Claude's order, urgent and important first unless the group is a sequence. */
function ordered(c: Checklist) {
  return groupsOf(c).map(g => {
    const seq = g.name && isSequence(c, g.name) ? sequenceOf(c, g.name) : []
    const tasks = seq.length ? g.tasks : [...g.tasks].sort((a, b) => rank(a) - rank(b))
    return { ...g, tasks, seq }
  })
}

export function drawPane(els: Elements[keyof Elements], app: App, sid: string, view: View, act: Actions): RenderElement {
  const { Box, Text, Button, Code } = els
  // The phone app has no text fields: there the pane shows the list with its buttons only.
  const Input = 'Input' in els ? els.Input : undefined
  const width = Math.max(20, Math.min(view.width, 100))
  const rule = <Text dimColor>{'─'.repeat(width)}</Text>

  if (!app.isOn)
    return (
      <Box flexDirection="column">
        <Text bold>Checklists are in the VS Code extension now.</Text>
        <Text dimColor>To use them here again, type /checklist use-mod.</Text>
      </Box>
    )

  const c = app.current(sid)
  if (!c)
    return (
      <Box flexDirection="column">
        <Text bold>No checklist in this chat yet.</Text>
        <Text dimColor>When Claude needs you to do something by hand or make a decision, it appears here.</Text>
        {app.others(sid).length > 0 && <Text dimColor>To pick up an earlier one, type /checklist list.</Text>}
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
  const openTask = open.find(t => t.id === view.openId) ?? current
  const unsent = app.store.updateSummary(c, 'line').ids.length

  const tags = (list: string[]) =>
    list.map(x => (
      <Text color={TAG_COLOR[x]} dimColor={!TAG_COLOR[x]}>
        {' '}
        {x}
      </Text>
    ))

  const shots = (owner: Task | Question, imgs: Img[]) => (
    <Box flexDirection="column">
      {imgs.map((img, i) => (
        <Box flexDirection="row" gap={1}>
          <Text>
            Screenshot {i + 1} <Text dimColor>({shotName(c.id, img)})</Text>
          </Text>
          <Button
            key={`${owner.id}-rm-${img.id}`}
            label="Remove"
            dimColor
            onPress={async () => {
              app.store.removeImage(c.id, owner.id, img.id)
              await save()
            }}
          />
        </Box>
      ))}
    </Box>
  )

  /** The note box, screenshots and their buttons, under an open task or question. */
  const extras = (owner: Task | Question, note: string, setNote: (v: string) => void, imgs: Img[], withShots = true) => (
    <Box flexDirection="column" marginTop={1}>
      {Input && (
        <Input
          key={`${owner.id}-note`}
          label="Note for Claude"
          placeholder="Optional: what you did, a value Claude needs…"
          value={note}
          submitLabel="Save"
          onInput={setNote}
          onSubmit={async v => {
            setNote(v)
            await save()
          }}
        />
      )}
      {shots(owner, imgs)}
      {withShots && imgs.length < 8 && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key={`${owner.id}-paste`} label="Paste screenshot" hotkey="v" onPress={() => act.paste(c, owner.id)} />
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

  const taskCard = (t: Task, step?: string) => {
    const isCurrent = t === current
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={rank(t) === 0 ? 'error' : 'suggestion'} paddingX={1} marginY={1}>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{t.id}</Text>
          <Text bold wrap="wrap">
            {t.text}
          </Text>
        </Box>
        {(step || t.tags.length > 0 || isCurrent) && (
          <Text>
            {isCurrent && <Text color="suggestion">Next task </Text>}
            {step && <Text dimColor>{step} </Text>}
            {tags(t.tags)}
          </Text>
        )}
        {t.detail && <Text>{t.detail}</Text>}
        {t.command && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Command to run:</Text>
            <Code source={t.command} language="shell" />
          </Box>
        )}
        {extras(t, t.draft.note, v => app.store.setDraft(c.id, t.id, { note: v }), t.draft.images)}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button
            key={`${t.id}-share-done`}
            label="Done, share with Claude"
            variant="primary"
            hotkey="d"
            autoFocus
            onPress={async () => {
              app.store.setDraft(c.id, t.id, { done: true })
              app.store.share(c.id, t.id)
              await save()
            }}
          />
          <Button
            key={`${t.id}-share-notdone`}
            label="Couldn't do it, share note"
            hotkey="n"
            onPress={async () => {
              app.store.setDraft(c.id, t.id, { done: false })
              app.store.share(c.id, t.id)
              await save()
            }}
          />
        </Box>
      </Box>
    )
  }

  const taskLine = (t: Task, step?: string) => (
    <Button key={`${t.id}-open`} plain onPress={() => act.open(t.id)}>
      <Text color={rank(t) === 0 ? 'error' : undefined}>{rank(t) === 0 ? '!' : '○'} </Text>
      <Text dimColor>{t.id} </Text>
      {step ? `${step}  ` : ''}
      {t.text}
      {t.draft.note || t.draft.images.length ? <Text dimColor> (draft)</Text> : ''}
      {tags(t.tags)}
    </Button>
  )

  const questionCard = (q: Question, first: boolean) => {
    const picks = q.draft.picks
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={q.tags.includes('urgent') ? 'error' : 'warning'} paddingX={1} marginY={1}>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{q.id}</Text>
          <Text bold wrap="wrap">
            {q.question}
          </Text>
        </Box>
        {q.tags.length > 0 && <Text>{tags(q.tags)}</Text>}
        {q.why && <Text>{q.why}</Text>}
        <Text dimColor>{q.multi ? 'Pick one or more:' : 'Pick one:'}</Text>
        {q.options.map((o, i) => {
          const on = picks.includes(o.id)
          return (
            <Box flexDirection="column">
              <Button
                key={`${q.id}-opt-${o.id}`}
                plain
                hotkey={first && i < 9 ? String(i + 1) : undefined}
                onPress={async () => {
                  const next = q.multi ? (on ? picks.filter(p => p !== o.id) : [...picks, o.id]) : [o.id]
                  app.store.setAnswerDraft(c.id, q.id, { picks: next })
                  await save()
                }}
              >
                <Text color={on ? 'suggestion' : undefined}>{on ? (q.multi ? '[x] ' : '(•) ') : q.multi ? '[ ] ' : '( ) '}</Text>
                <Text bold={on}>{o.label}</Text>
                {q.recommended === o.id ? <Text color="success"> recommended</Text> : ''}
              </Button>
              {(o.summary || o.details) && <Text dimColor>{'    '}{o.summary ?? o.details}</Text>}
            </Box>
          )
        })}
        {q.recommended && q.reason && <Text dimColor>Why Claude recommends it: {q.reason}</Text>}
        {Input && q.allowOther && (
          <Box marginTop={1}>
            <Input
              key={`${q.id}-other`}
              label="Something else"
              placeholder="Type your own answer"
              value={q.draft.other}
              submitLabel="Save"
              onInput={v => app.store.setAnswerDraft(c.id, q.id, { other: v })}
              onSubmit={async v => {
                app.store.setAnswerDraft(c.id, q.id, { other: v })
                await save()
              }}
            />
          </Box>
        )}
        {extras(q, q.draft.note, v => app.store.setAnswerDraft(c.id, q.id, { note: v }), q.draft.images, false)}
        <Box marginTop={1}>
          <Button
            key={`${q.id}-answer`}
            label={`Answer ${q.id}`}
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
    seen ? <Text color="success"> · Claude read it</Text> : pushed ? <Text dimColor> · sent</Text> : <Text dimColor> · not read yet</Text>

  const sharedRows = () => (
    <Box flexDirection="column">
      {answered.map(q => {
        const a = q.answer!
        const choice = [...q.options.filter(o => a.picks.includes(o.id)).map(o => o.label), ...(a.other ? [a.other] : [])].join(', ')
        return (
          <Box flexDirection="row" gap={1}>
            <Text>
              <Text color="success">✓ </Text>
              <Text dimColor>{q.id} </Text>
              {q.question} <Text bold>{choice}</Text>
              {readMark(!!q.seenAt && q.seenAt >= a.at, !!q.pushedAt)}
            </Text>
            <Button
              key={`${q.id}-change`}
              label="Change"
              dimColor
              onPress={async () => {
                app.store.unshareAnswer(c.id, q.id)
                await save()
              }}
            />
          </Box>
        )
      })}
      {shared.map(t => {
        const s = t.shared!
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text>
                <Text color={s.done ? 'success' : 'warning'}>{s.done ? '✓ ' : '– '}</Text>
                <Text dimColor>{t.id} </Text>
                <Text dimColor={s.done}>{t.text}</Text>
                {!s.done && <Text color="warning"> not done</Text>}
                {readMark(!!t.seenAt && t.seenAt >= s.at, !!t.pushedAt)}
              </Text>
              <Button
                key={`${t.id}-unshare`}
                label="Take back"
                dimColor
                onPress={async () => {
                  app.store.unshare(c.id, t.id)
                  await save()
                }}
              />
            </Box>
            {(s.note || s.images.length > 0) && (
              <Text dimColor>
                {'    '}
                {s.note ? `Note: ${s.note}` : ''}
                {s.note && s.images.length ? ' · ' : ''}
                {s.images.length ? plural(s.images.length, 'screenshot') : ''}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )

  const total = all.length + questions.length
  const finished = shared.length + answered.length
  const filled = total ? Math.round((finished / total) * Math.min(width, 40)) : 0
  const away = app.store.isAway(c)

  return (
    <Box flexDirection="column">
      <Text bold size="title">
        {c.title}
      </Text>
      <Box flexDirection="row">
        <Text color="success">{'━'.repeat(filled)}</Text>
        <Text dimColor>{'━'.repeat(Math.min(width, 40) - filled)}</Text>
      </Box>
      <Text dimColor>
        {finished} of {total} shared with Claude
        {asking.length ? ` · ${plural(asking.length, 'question')} to answer` : ''}
        {open.length ? ` · ${open.length} to do` : ''}
      </Text>

      {away && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color="warning">☾ Away until {c.awayLabel ?? 'later'}. Claude won't wait for you.</Text>
          <Button
            key="back"
            label="I'm back"
            onPress={async () => {
              app.store.endAway(c.id)
              await save()
            }}
          />
        </Box>
      )}

      {unsent > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Button key="send" label={`Send ${plural(unsent, 'update')} to Claude now`} variant="primary" hotkey="s" onPress={() => act.send(c)} />
          <Text dimColor>Otherwise Claude sees them the next time it reads the checklist.</Text>
        </Box>
      )}

      {!open.length && !asking.length && (
        <Box marginTop={1}>
          <Text color="success">✓ All done. Claude has everything it asked for.</Text>
        </Box>
      )}

      {asking.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rule}
          <Text bold>
            Decide <Text dimColor>({asking.length})</Text>
          </Text>
          {asking.map((q, i) => questionCard(q, i === 0))}
        </Box>
      )}

      {open.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rule}
          <Text bold>
            To do <Text dimColor>({open.length})</Text>
          </Text>
          {groups.filter(g => g.tasks.some(t => !t.shared)).map(g => {
            const left = g.tasks.filter(t => !t.shared)
            const how = g.phase ? `phase ${g.phase} of ${g.phases}, in order` : g.seq.length ? 'in order' : ''
            return (
              <Box flexDirection="column" marginTop={g.name ? 1 : 0}>
                {g.name && (
                  <Text bold>
                    {g.name}
                    {how ? <Text dimColor> ({how})</Text> : ''}
                  </Text>
                )}
                {left.map(t => {
                  const step = g.seq.length ? `Step ${g.seq.indexOf(t) + 1} of ${g.seq.length}` : undefined
                  return t === openTask ? taskCard(t, step) : taskLine(t, step)
                })}
              </Box>
            )
          })}
        </Box>
      )}

      {finished > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rule}
          <Button key="shared-toggle" plain onPress={() => act.toggleShared()}>
            <Text bold>
              {view.showShared ? '▾' : '▸'} Shared with Claude <Text dimColor>({finished})</Text>
            </Text>
          </Button>
          {view.showShared && sharedRows()}
        </Box>
      )}

      {Input && (open.length > 0 || asking.length > 0) && (
        <Box marginTop={1}>
          <Text dimColor>Tab moves between buttons. Keys: d done · n couldn't do it · v paste screenshot · 1–9 pick · s send</Text>
        </Box>
      )}
    </Box>
  )
}
