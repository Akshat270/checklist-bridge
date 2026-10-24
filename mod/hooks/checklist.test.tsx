// Run with `claude plugin test mod`. The hooks `on` registers here stand for Claude Code beneath the mod:
// an in-memory file system, the environment, the session id, and records of what the mod showed and sent.
import { expect, test } from 'claude-code/testing'

const ROOT = '/home/u/.checklist-bridge'
const CWD = '/work/My App'
const T = 'mcp__checklist-bridge__'

function world(on: any, files: Record<string, string> = {}) {
  const chat = { sid: 'chat-1' }
  // What the clipboard holds for "Paste screenshot": 'image', 'text' or 'no-tool' (wl-paste/xclip missing).
  const clipboard = { holds: 'image' as 'image' | 'text' | 'no-tool', runs: [] as string[][] }
  const seen = { status: [] as (string | undefined)[], toasts: [] as string[], prompts: [] as string[], opened: 0, tools: [] as string[] }
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(e.path + '/')) }))
  on('fs.read', (_: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', (_: any, e: any) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(e.path + '/') && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_: any, e: any) => {
    clipboard.runs.push([...e.argv])
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }
    if (clipboard.holds === 'no-tool') return { value: { exitCode: 0, stdout: 'notool\n', stderr: '' } }
    if (clipboard.holds === 'image') files[e.init.env.CB_SHOT] = 'PNG'
    return { value: { exitCode: 0, stdout: clipboard.holds === 'image' ? 'ok\n' : 'none\n', stderr: '' } }
  })
  on('session.id', () => ({ value: chat.sid }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => {
    seen.tools.push(e.name)
    return { value: {} }
  })
  on('ui.open', () => {
    seen.opened++
    return { value: { isPlaced: true } }
  })
  on('ui.status', (_: any, e: any) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_: any, e: any) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_: any, e: any) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  return { files, seen, chat, clipboard }
}

const PANE = {
  plugin: 'checklist-bridge',
  component: 'Pane',
  requestId: 'checklist',
  props: { title: 'Checklist', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const textOf = (r: any) =>
  typeof r?.result === 'string' ? r.result : (r?.result ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')

test('Claude adds tasks, the user shares one, Send now hands it to Claude', async ($, on) => {
  const { files, seen } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(seen.tools.sort()).toEqual(['checklist_add_tasks', 'checklist_ask', 'checklist_edit', 'checklist_read'])

  const added = await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'Launch', tasks: [{ text: 'Create an API key' }, { text: 'Set STRIPE_KEY' }] } as any)
  expect(textOf(added)).toMatch(/Added 2 tasks \(t1–t2\) to the checklist "Launch"\./)
  expect(textOf(added)).not.toMatch(/VS Code/)
  expect(seen.opened).toBe(1)
  const saved = Object.keys(files).filter(f => f.endsWith('.json'))
  expect(saved.length).toBe(1)
  expect(saved[0]).toMatch(new RegExp(`^${ROOT}/mod/my-app-[0-9a-f]{8}/[0-9a-f-]+\\.json$`))
  expect(seen.status.at(-1)).toBe('2 on your checklist (/checklist)')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The next task is open as a card; the other is one line you can open.
    expect(await ui.find({ type: 'Text', text: /Create an API key/ })).toBeDefined()
    expect(await ui.find({ key: 't1-share-done' })).toBeDefined()
    expect(await ui.find({ key: 't2-share-done' })).toBeUndefined()
    expect(await ui.find({ key: 't2-open' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 tasks waiting on you/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Collapse folds the open card: every task is one line until one is opened again.
  await ui.press({ key: 't1-collapse' })
  expect(await ui.find({ key: 't1-share-done' })).toBeUndefined()
  expect(await ui.find({ key: 't1-open' })).toBeDefined()
  await ui.press({ key: 't2-open' })
  expect(await ui.find({ key: 't2-share-done' })).toBeDefined()
  expect(await ui.find({ key: 't1-share-done' })).toBeUndefined()
  await ui.press({ key: 't1-open' })
  await ui.input({ key: 't1-note', text: 'key is in 1Password' })
  await ui.input({ key: 't1-shot', text: '/home/u/Desktop/key.png' })
  expect(await ui.find({ type: 'Text', text: /Screenshot 1/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.press({ key: 't1-share-done' })
  // Shared: it leaves To do, the next task opens, and Send now appears at the top.
  expect(await ui.find({ key: 't1-share-done' })).toBeUndefined()
  expect(await ui.find({ key: 't2-share-done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\/2/ })).toBeDefined()
  expect(await ui.find({ key: 't1-unshare' })).toBeUndefined()
  await ui.press({ key: 'shared-toggle' })
  expect(await ui.find({ key: 't1-unshare' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /“key is in 1Password”/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▣ 1 screenshot/ })).toBeDefined()
  expect(seen.status.at(-1)).toBe('1 on your checklist, 1 shared, not sent (/checklist)')
  await ui.press({ key: 'send' })
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toMatch(/t1/)
  expect(seen.prompts[0]).toMatch(/1Password/)
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.unmount()

  const r = textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))
  expect(r).toMatch(/t1 Create an API key: DONE/)
  expect(r).toMatch(/\/home\/u\/Desktop\/key\.png \(open it with your Read tool\)/)
  expect(r).not.toMatch(/VS Code|checklist_wait/)
})

test('answering a question', async ($, on) => {
  const { seen } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: `${T}checklist_ask`,
    questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], recommended: 'SQLite' }],
  } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'q1-answer' })
  expect(seen.toasts.at(-1)).toMatch(/Pick an option/)
  expect(await ui.find({ type: 'Text', text: /recommended/ })).toBeDefined()
  await ui.press({ key: 'q1-opt-' + (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).find((k: string) => k?.startsWith('q1-opt-'))!.slice(7) })
  await ui.press({ key: (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k?.startsWith('q1-opt-'))[1] })
  await ui.press({ key: 'q1-answer' })
  expect(await ui.find({ key: 'q1-answer' })).toBeUndefined()
  await ui.press({ key: 'shared-toggle' })
  expect(await ui.find({ type: 'Text', text: /Which DB\? SQLite/ })).toBeDefined()
  await ui.unmount()
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/ANSWER: SQLite/)
})

test('the phone app shows the list without text fields', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Check the page' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /Check the page/ })).toBeDefined()
  expect(await ui.find({ key: 't1-share-done' })).toBeDefined()
  expect(await ui.find({ key: 't1-paste' })).toBeDefined()
  expect(await ui.find({ key: 't1-note' })).toBeUndefined()
  await ui.unmount()
})

test('checklists are still there in the next session, and a broken file falls back to its backup', async ($, on) => {
  const files: Record<string, string> = {}
  world(on, files)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  const main = Object.keys(files).find(f => f.endsWith('.json'))!
  files[main] = files[main]!.slice(0, 20) // cut short
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/1 tasks/)
})

test('instructions are added to the system prompt', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  const mine = r.sections.find(s => s.id === 'checklist-bridge:instructions')
  expect(mine?.text).toMatch(/checklist_add_tasks/)
  expect(mine?.text).not.toMatch(/checklist_wait/)
})

test('switching to the extension and back', async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'checklist', args: 'use-extension' } as any)
  expect(out.text).toMatch(/Switched to the VS Code extension/)
  expect(JSON.parse(files[`${ROOT}/mode.json`]!).use).toBe('extension')
  expect(textOf(await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'x' }] } as any))).toMatch(/switched Checklist Bridge to the VS Code extension/)

  // A new session reads the choice.
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.some(s => s.id === 'checklist-bridge:instructions')).toBe(false)

  await $.command.run({ command: 'checklist', args: 'use-mod' } as any)
  expect(JSON.parse(files[`${ROOT}/mode.json`]!).use).toBe('mod')
  const denied = await $.tool.call({ tool: 'mcp__checklist__checklist_read' } as any)
  expect((denied as any).deny).toMatch(/runs as a Claude Code mod now/)
})

test('away and back', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  expect((await $.command.run({ command: 'checklist', args: 'away 2h' } as any)).text).toMatch(/away until/)
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/THE USER IS AWAY/)
  expect((await $.command.run({ command: 'checklist', args: 'back' } as any)).text).toMatch(/Welcome back/)
  expect((await $.command.run({ command: 'checklist', args: 'away soon' } as any)).text).toMatch(/Say how long/)
})

test('an earlier checklist can be continued in a new chat', async ($, on) => {
  const { chat } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'Old work', tasks: [{ text: 'One' }] } as any)
  chat.sid = 'chat-2'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'checklist', args: 'list' } as any)).text).toMatch(/1\. Old work: 1 tasks waiting/)
  expect((await $.command.run({ command: 'checklist', args: 'continue 1' } as any)).text).toMatch(/"Old work" is this chat's checklist now/)
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/Checklist "Old work"/)
})

test('Paste screenshot saves the image on the clipboard to the task', async ($, on) => {
  const { files, seen, clipboard } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Check the page' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  clipboard.holds = 'text'
  await ui.press({ key: 't1-paste' })
  expect(seen.toasts.at(-1)).toMatch(/No image on the clipboard/)
  expect(await ui.find({ type: 'Text', text: /Screenshot 1/ })).toBeUndefined()

  clipboard.holds = 'no-tool'
  await ui.press({ key: 't1-paste' })
  expect(seen.toasts.at(-1)).toMatch(/wl-clipboard|xclip/)

  clipboard.holds = 'image'
  await ui.press({ key: 't1-paste' })
  expect(seen.toasts.at(-1)).toBe('Screenshot added.')
  expect(await ui.find({ type: 'Text', text: /Screenshot 1/ })).toBeDefined()
  const run = clipboard.runs.at(-1)!
  expect(run[0]).toBe('sh')
  const shot = Object.keys(files).find(f => f.endsWith('.png'))!
  expect(shot).toMatch(new RegExp(`^${ROOT}/mod/images/[0-9a-f-]+-t1-\\w+\\.png$`))
  await ui.press({ key: 't1-share-done' })
  await ui.unmount()
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toContain(`${shot} (open it with your Read tool)`)

  // Claude may open that screenshot without asking, but nothing else (Claude Code's own verdict here is "ask").
  expect((await $.tool.check({ tool: 'Read', input: { file_path: shot } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: `${ROOT}/mod/images/other.png` } })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/etc/passwd' } })).decision).toBe('ask')
})

test('☾ Away in the pane: pick a time, add 30 minutes, come back', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'away-3600000' })).toBeUndefined()
  await ui.press({ key: 'away' })
  expect(await ui.find({ type: 'Text', text: /Going away\?/ })).toBeDefined()
  await ui.press({ key: 'away-cancel' })
  expect(await ui.find({ key: 'away-3600000' })).toBeUndefined()

  await ui.press({ key: 'away' })
  await ui.press({ key: 'away-3600000' })
  expect(await ui.find({ key: 'away' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1 h left · Claude won't wait for you/ })).toBeDefined()
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/THE USER IS AWAY until .* \(in 1 hour\)/)

  await ui.press({ key: 'away-more' })
  expect(await ui.find({ type: 'Text', text: /1 h 30 min left/ })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'away' })).toBeDefined()
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).not.toMatch(/AWAY/)
  await ui.unmount()
})
