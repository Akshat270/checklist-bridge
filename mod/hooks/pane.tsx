// The checklist pane: the same checklist as the VS Code panel, drawn with Claude Code's own elements.
// Calm and plain (see DESIGN.md): ids always shown, colour only for what needs the user.
// No `$` here: register.tsx resolves the elements and passes in what a press should do.
import type { Elements, RenderElement } from 'claude-code'

import type { App } from './app'
import { groupsOf, isSequence, sequenceOf, type Checklist, type Img, type Question, type Task } from './lib/model'

const tagText = (tags: string[]) => (tags.length ? ` [${tags.join(', ')}]` : '')
const URGENT = new Set(['urgent', 'blocked'])

export type Actions = {
  /** Saves `c` and redraws. */
  changed: (c: Checklist) => Promise<void>
  toast: (text: string) => void
  /** Send now. */
  send: (c: Checklist) => Promise<void>
}

export function drawPane(els: Elements[keyof Elements], app: App, sid: string, act: Actions): RenderElement {
  const { Box, Text, Button } = els
  // The phone app has no text fields: there the pane shows the list with its buttons only.
  const Input = 'Input' in els ? els.Input : undefined

  if (!app.isOn)
    return (
      <Box flexDirection="column">
        <Text>Checklists are in the VS Code extension now.</Text>
        <Text dimColor>Run /checklist use-mod to use them here again.</Text>
      </Box>
    )

  const c = app.current(sid)
  if (!c)
    return (
      <Box flexDirection="column">
        <Text>No checklist in this chat yet.</Text>
        <Text dimColor>When Claude needs you to do something by hand or make a decision, it shows up here.</Text>
        {app.others(sid).length > 0 && <Text dimColor>Run /checklist list to continue an earlier one.</Text>}
      </Box>
    )

  const save = () => act.changed(c)
  const toast = act.toast

  const shots = (owner: Task | Question, imgs: Img[], locked: boolean) => (
    <Box flexDirection="column">
      {imgs.map(img => (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Screenshot: {img.path ?? '(saved)'}</Text>
          {!locked && (
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
          )}
        </Box>
      ))}
      {!locked && Input && imgs.length < 8 && (
        <Input
          key={`${owner.id}-shot`}
          placeholder="Add a screenshot: type or drop its file path"
          submitLabel="Add"
          onSubmit={async v => {
            if (!v.trim()) return
            if (!app.store.addImagePath(c.id, owner.id, v)) return toast('That is not a .png, .jpg, .gif or .webp file.')
            await save()
          }}
        />
      )}
    </Box>
  )

  const taskRow = (t: Task, step?: string) => {
    const s = t.shared
    const done = s ? s.done : t.draft.done
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Button
            key={`${t.id}-done`}
            label={done ? '[x]' : '[ ]'}
            plain
            onPress={async () => {
              if (s) return toast(`Unshare ${t.id} first to change it.`)
              app.store.setDraft(c.id, t.id, { done: !t.draft.done })
              await save()
            }}
          />
          <Text bold={!done} dimColor={!!s} strikethrough={done && !!s} color={t.tags.some(x => URGENT.has(x)) && !s ? 'red' : undefined}>
            {t.id}
            {step ?? ''} {t.text}
            {tagText(t.tags)}
          </Text>
        </Box>
        {t.detail && <Text dimColor>{t.detail}</Text>}
        {t.command && <Text mono>{t.command}</Text>}
        {s ? (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>
              Shared{t.seenAt && t.seenAt >= s.at ? ', Claude has read it' : t.pushedAt ? ', sent' : ''}
              {s.note ? `. Note: ${s.note}` : ''}
            </Text>
            <Button
              key={`${t.id}-unshare`}
              label="Unshare"
              plain
              dimColor
              onPress={async () => {
                app.store.unshare(c.id, t.id)
                await save()
              }}
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            {Input && (
              <Input
                key={`${t.id}-note`}
                placeholder="Note for Claude (optional)"
                value={t.draft.note}
                submitLabel="Save"
                onInput={v => app.store.setDraft(c.id, t.id, { note: v })}
                onSubmit={async v => {
                  app.store.setDraft(c.id, t.id, { note: v })
                  await save()
                }}
              />
            )}
            {shots(t, t.draft.images, false)}
            <Button
              key={`${t.id}-share`}
              label={`Share ${t.id} with Claude`}
              onPress={async () => {
                app.store.share(c.id, t.id)
                await save()
              }}
            />
          </Box>
        )}
      </Box>
    )
  }

  const questionRow = (q: Question) => {
    const a = q.answer
    const picks = a ? a.picks : q.draft.picks
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold={!a} color={q.tags.some(x => URGENT.has(x)) && !a ? 'red' : undefined}>
          {q.id} {q.question}
          {tagText(q.tags)}
        </Text>
        {q.why && <Text dimColor>{q.why}</Text>}
        {q.options.map(o => (
          <Box flexDirection="column">
            <Button
              key={`${q.id}-opt-${o.id}`}
              label={`${picks.includes(o.id) ? (q.multi ? '[x]' : '(•)') : q.multi ? '[ ]' : '( )'} ${o.label}${q.recommended === o.id ? ' (recommended)' : ''}`}
              plain
              onPress={async () => {
                if (a) return toast(`Change your answer to ${q.id} first.`)
                const next = q.multi ? (picks.includes(o.id) ? picks.filter(p => p !== o.id) : [...picks, o.id]) : [o.id]
                app.store.setAnswerDraft(c.id, q.id, { picks: next })
                await save()
              }}
            />
            {o.summary && <Text dimColor>    {o.summary}</Text>}
          </Box>
        ))}
        {q.recommended && q.reason && <Text dimColor>Why Claude recommends it: {q.reason}</Text>}
        {a ? (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>
              Answered{q.seenAt && q.seenAt >= a.at ? ', Claude has read it' : q.pushedAt ? ', sent' : ''}
              {a.other ? `. Something else: ${a.other}` : ''}
              {a.note ? `. Note: ${a.note}` : ''}
            </Text>
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
          </Box>
        ) : (
          <Box flexDirection="column">
            {Input && q.allowOther && (
              <Input
                key={`${q.id}-other`}
                placeholder="Something else"
                value={q.draft.other}
                submitLabel="Save"
                onInput={v => app.store.setAnswerDraft(c.id, q.id, { other: v })}
                onSubmit={async v => {
                  app.store.setAnswerDraft(c.id, q.id, { other: v })
                  await save()
                }}
              />
            )}
            {Input && (
              <Input
                key={`${q.id}-note`}
                placeholder="Note for Claude (optional)"
                value={q.draft.note}
                submitLabel="Save"
                onInput={v => app.store.setAnswerDraft(c.id, q.id, { note: v })}
                onSubmit={async v => {
                  app.store.setAnswerDraft(c.id, q.id, { note: v })
                  await save()
                }}
              />
            )}
            {shots(q, q.draft.images, false)}
            <Button
              key={`${q.id}-answer`}
              label={`Answer ${q.id}`}
              onPress={async () => {
                if (!app.store.shareAnswer(c.id, q.id)) return toast(`Pick an option for ${q.id} first.`)
                await save()
              }}
            />
          </Box>
        )}
      </Box>
    )
  }

  const questions = c.questions.filter(q => !q.retired)
  const fresh = app.store.updateSummary(c, 'line').ids.length
  const left = c.tasks.filter(t => !t.shared).length + questions.filter(q => !q.answer).length
  const away = app.store.isAway(c)

  return (
    <Box flexDirection="column">
      <Text bold>{c.title}</Text>
      <Text dimColor>{left ? `${left} waiting on you` : 'Nothing waiting on you'}</Text>
      {away && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color="yellow">Away until {c.awayLabel ?? 'later'}. Claude won't wait for you.</Text>
          <Button
            key="back"
            label="I'm back"
            plain
            onPress={async () => {
              app.store.endAway(c.id)
              await save()
            }}
          />
        </Box>
      )}
      {questions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Decide</Text>
          {questions.map(questionRow)}
        </Box>
      )}
      {groupsOf(c).map(g => {
        const whole = g.name && isSequence(c, g.name) ? sequenceOf(c, g.name) : []
        const how = g.phase ? ` (phase ${g.phase} of ${g.phases}, in order)` : g.ordered ? ' (in order)' : ''
        return (
          <Box flexDirection="column" marginTop={1}>
            {g.name && <Text bold>{g.name + how}</Text>}
            {g.tasks.map(t => taskRow(t, whole.length ? ` step ${whole.indexOf(t) + 1}/${whole.length}` : undefined))}
          </Box>
        )
      })}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button
          key="send"
          label={fresh ? `Send now (${fresh})` : 'Send now'}
          variant="primary"
          onPress={() => act.send(c)}
        />
      </Box>
    </Box>
  )
}
