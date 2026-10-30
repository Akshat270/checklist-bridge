// Run with `claude plugin test mod`. The hooks `on` registers here stand for Claude Code beneath the mod:
// an in-memory file system, the environment, the session id, and records of what the mod showed and sent.
import { expect, mock, test } from 'claude-code/testing'
import { FOLDER_NOTE, HANDED_NOTE, sharedDir } from './lib/handover'
import { ChecklistStore } from './lib/model'
import { palette } from './theme'

const ROOT = '/home/u/.checklist-bridge'
const CWD = '/work/My App'
const T = 'mcp__checklist-bridge__'

function world(on: any, files: Record<string, string> = {}) {
  const chat = { sid: 'chat-1' }
  // How many of the next writes fail (a file locked for a moment).
  // When each file last changed (a test can set one in the past), and how many times each was read.
  const disk = { failWrites: 0, writes: 0, mtimes: {} as Record<string, number>, reads: {} as Record<string, number> }
  // What the clipboard holds for "Paste screenshot": 'image', 'text' or 'no-tool' (wl-paste/xclip missing).
  const clipboard = { holds: 'image' as 'image' | 'text' | 'no-tool', runs: [] as string[][] }
  const seen = { status: [] as (string | undefined)[], toasts: [] as string[], prompts: [] as string[], opened: 0, tools: [] as string[], copied: [] as string[] }
  const env: Record<string, string> = { HOME: '/home/u' }
  on('env.get', (_: any, e: any) => ({ value: env[e.name] }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(e.path + '/')) }))
  on('fs.read', (_: any, e: any) => {
    disk.reads[e.path] = (disk.reads[e.path] ?? 0) + 1
    return e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }
  })
  on('fs.write', (_: any, e: any) => {
    if (disk.failWrites > 0) {
      disk.failWrites--
      return { deny: 'EBUSY: the file is locked' }
    }
    files[e.path] = e.text
    disk.writes++
    disk.mtimes[e.path] = Date.now()
    return { value: undefined }
  })
  on('fs.list', (_: any, e: any) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(e.path + '/') && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: disk.mtimes[f] ?? Date.now(), isLink: false })),
  }))
  on('process.run', (_: any, e: any) => {
    clipboard.runs.push([...e.argv])
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }
    if (clipboard.holds === 'no-tool') return { value: { exitCode: 0, stdout: 'notool\n', stderr: '' } }
    if (clipboard.holds === 'image') files[e.init.env.CB_SHOT] = 'PNG'
    return { value: { exitCode: 0, stdout: clipboard.holds === 'image' ? 'ok\n' : 'none\n', stderr: '' } }
  })
  on('session.id', () => ({ value: chat.sid }))
  // VS Code windows on this machine: each port answers with `net.answer` (none: nothing listens there).
  const net = { posts: [] as { url: string; auth?: string; body: any }[], answer: {} as Record<number, (route: string, body: any) => { status: number; text: string } | 'drop' | 'hang'> }
  on('http.fetch', (_: any, e: any) => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)(\/\w+)$/.exec(e.url)
    const answer = m && net.answer[Number(m[1])]
    if (!answer) return { deny: 'ECONNREFUSED' }
    const body = JSON.parse(e.init?.body ?? '{}')
    net.posts.push({ url: e.url, auth: e.init?.headers?.Authorization, body })
    const r = answer(m![2]!, body)
    if (r === 'drop') return { deny: 'ECONNRESET' } // got it, then went away without an answer
    if (r === 'hang') return new Promise(() => {}) // got it, and never answers
    return { value: { ...r, ok: true, headers: {} } }
  })
  on('tool.check', () => ({ decision: 'ask' }))
  on('ui.copy', (_: any, e: any) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true } }
  })
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
  return { files, seen, chat, clipboard, disk, net, env }
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
  expect(await ui.find({ type: 'Text', text: /▣ 1/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /Which DB\?\s+SQLite/ })).toBeDefined()
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

  // A new session in the same process (a resume) reads the choice; its tools are still there, and reach VS Code.
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.find(s => s.id === 'checklist-bridge:instructions')?.text).toMatch(/The checklist is in VS Code now/)

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
  expect(await ui.find({ type: 'Text', text: /^1 h left$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude won't wait for you/ })).toBeDefined()
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/THE USER IS AWAY until .* \(in 1 hour\)/)

  await ui.press({ key: 'away-more' })
  expect(await ui.find({ type: 'Text', text: /1 h 30 min left/ })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'away' })).toBeDefined()
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).not.toMatch(/AWAY/)
  await ui.unmount()
})

test('copy puts a task\'s command on the clipboard', async ($, on) => {
  const { seen } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Check the version', command: 'node --version' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /node --version/ })).toBeDefined()
  await ui.press({ key: 't1-copy' })
  expect(seen.copied).toEqual(['node --version'])
  expect(seen.toasts.at(-1)).toBe('Copied.')
  await ui.unmount()
})

test('the light colours draw the same pane', { options: { colors: 'light' } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One', tags: ['urgent'] }] } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 't1-share-done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /URGENT/ })).toBeDefined()
    await ui.unmount()
  }
})

/** The one checklist file in the shared folder, and a way to change it as another chat or VS Code would. */
const listFile = (files: Record<string, string>) => Object.keys(files).find(f => /\/mod\/my-app-[0-9a-f]{8}\/[^/]+\.json$/.test(f))!
const elsewhere = (files: Record<string, string>, change: (c: any) => void) => {
  const f = listFile(files)
  const c = JSON.parse(files[f]!)
  change(c)
  c.updatedAt += 1000
  files[f] = files[`${f}.bak`] = JSON.stringify(c)
}

test('a change made elsewhere is not overwritten by this chat\'s older copy', async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  // VS Code (or another chat) shares t1 in the file meanwhile.
  elsewhere(files, c => (c.tasks[0].shared = { at: Date.now(), done: true, note: 'done in VS Code', images: [] }))
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any)
  const saved = JSON.parse(files[listFile(files)]!)
  expect(saved.tasks.map((t: any) => t.id)).toEqual(['t1', 't2'])
  expect(saved.tasks[0].shared?.note).toBe('done in VS Code')

  // The pane, too, works on the latest copy.
  elsewhere(files, c => (c.tasks[1].text = 'Two, renamed elsewhere'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't2-share-done' })
  await ui.unmount()
  const after = JSON.parse(files[listFile(files)]!)
  expect(after.tasks[1].text).toBe('Two, renamed elsewhere')
  expect(after.tasks[1].shared?.done).toBe(true)
})

test('after switching to VS Code elsewhere, this chat writes nothing', async ($, on) => {
  const { files, seen } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  files[`${ROOT}/mode.json`] = JSON.stringify({ use: 'extension', at: Date.now() })
  const before = files[listFile(files)]
  await ui.press({ key: 't1-share-done' })
  expect(seen.toasts.at(-1)).toMatch(/in the VS Code extension now/)
  expect(files[listFile(files)]).toBe(before)
  expect(textOf(await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any))).toMatch(/switched Checklist Bridge to the VS Code extension/)
  expect(files[listFile(files)]).toBe(before)
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  // This chat keeps its tools, which now reach VS Code (none is open here), and Claude is told so.
  expect(r.sections.find(x => x.id === 'checklist-bridge:instructions')?.text).toMatch(/The checklist is in VS Code now/)
  await ui.unmount()
})

test('a write that fails is tried again, and Claude is not asked to repeat the change', async ($, on) => {
  const { files, disk } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  disk.failWrites = 1
  const r = await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  expect((r as any).deny).toBeUndefined()
  expect(textOf(r)).toMatch(/Added 1 task \(t1\)/)
  expect(textOf(r)).toMatch(/could not save the checklist just now/)
  expect(Object.keys(files).some(f => f.endsWith('.json') && !f.endsWith('mode.json'))).toBe(false)
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any)
  expect(JSON.parse(files[listFile(files)]!).tasks.map((t: any) => t.text)).toEqual(['One', 'Two'])
})

test('a checklist another chat took over with /checklist continue stays with that chat', async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'Old work', tasks: [{ text: 'One' }] } as any)
  // Another chat ran /checklist continue on it.
  elsewhere(files, c => (c.sessionId = 'chat-2'))
  const r = textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))
  expect(r).not.toMatch(/Old work/)
  expect(JSON.parse(files[listFile(files)]!).sessionId).toBe('chat-2')
})

test('a checklist whose first save stopped after its backup still loads', async ($, on) => {
  const files: Record<string, string> = {}
  world(on, files)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'Kept', tasks: [{ text: 'One' }] } as any)
  delete files[listFile(files)]
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/Checklist "Kept"/)
})

test('a typed screenshot path is stored as a full path', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 't1-shot', text: '~/Desktop/shot.png' })
  await ui.input({ key: 't1-shot', text: 'shots/b.png' })
  await ui.press({ key: 't1-share-done' })
  await ui.unmount()
  const r = textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))
  expect(r).toContain('/home/u/Desktop/shot.png (open it with your Read tool)')
  expect(r).toContain(`${CWD}/shots/b.png (open it with your Read tool)`)
})

test('only image files are opened without asking, even if a checklist file names another', async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  // The pane takes only image paths, but the file is plain JSON that something else could edit.
  const img = (path: string) => ({ id: path.slice(-6), mime: 'image/png', w: 0, h: 0, path })
  elsewhere(files, c => (c.tasks[0].shared = { at: Date.now(), done: true, note: '', images: [img('/home/u/.ssh/id_rsa'), img('/home/u/shot.PNG')] }))
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toContain('/home/u/.ssh/id_rsa')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/home/u/.ssh/id_rsa' } })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/home/u/shot.PNG' } })).decision).toBe('allow')
})

test('settled checklist files are not read again, and a backup only when its file is damaged', async ($, on) => {
  const { files, disk, chat } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'Old', tasks: [{ text: 'One' }] } as any)
  const old = listFile(files)
  expect(disk.reads[`${old}.bak`] ?? 0).toBe(0)

  // Another chat's checklist, last changed a minute ago: read once more, then left alone until it changes.
  chat.sid = 'chat-2'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  disk.mtimes[old] = Date.now() - 60_000
  await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'New', tasks: [{ text: 'Two' }] } as any)
  const reads = disk.reads[old]
  await $.tool.call({ tool: `${T}checklist_read` } as any)
  await $.tool.call({ tool: `${T}checklist_read` } as any)
  expect(disk.reads[old]).toBe(reads)

  // Changed elsewhere: its time moves, so it is read again.
  const c = JSON.parse(files[old]!)
  c.title = 'Old, renamed'
  c.updatedAt += 1000
  files[old] = JSON.stringify(c)
  disk.mtimes[old] = Date.now()
  await $.tool.call({ tool: `${T}checklist_read` } as any)
  expect(disk.reads[old]).toBe(reads + 1)
  expect(disk.reads[`${old}.bak`] ?? 0).toBe(0)

  // Damaged: then its backup is read.
  files[old] = '{ cut short'
  disk.mtimes[old] = Date.now() + 1
  await $.tool.call({ tool: `${T}checklist_read` } as any)
  expect(disk.reads[`${old}.bak`]).toBe(1)
})

test('the shared section is headed in green, so its focused button is green too', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }, { text: 'Two' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't1-share-done' })
  const head = await ui.find({ type: 'Text', text: /^SHARED WITH CLAUDE$/ })
  expect(head?.props.color).toBe(palette('dark').green)
  await ui.unmount()
})

test('a call that changes nothing writes nothing', async ($, on) => {
  const { disk } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  await $.tool.call({ tool: `${T}checklist_read` } as any) // marks what it read; nothing to mark after that
  const writes = disk.writes
  await $.tool.call({ tool: `${T}checklist_read` } as any)
  const afterRead = disk.writes
  await $.tool.call({ tool: `${T}checklist_edit`, task_id: 't9', text: 'nope' } as any)
  expect([afterRead, disk.writes]).toEqual([writes, writes])
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any)
  expect(disk.writes).toBeGreaterThan(writes)
})

test('a change that could not be saved is dropped once VS Code has the checklists', async ($, on) => {
  const { files, disk } = world(on)
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  disk.failWrites = 1
  expect(textOf(await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any))).toMatch(/could not save/)
  // VS Code takes the checklists back: the mode changes and the files are gone.
  files[`${ROOT}/mode.json`] = JSON.stringify({ use: 'extension', at: Date.now() })
  for (const f of Object.keys(files)) if (/\/mod\/my-app-/.test(f)) delete files[f]
  const writes = disk.writes
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'chat-1' } as any)
  expect(disk.writes).toBe(writes)
  expect(Object.keys(files).some(f => /\/mod\/my-app-/.test(f))).toBe(false)
})

/** A checklist as VS Code hands it over: named after its chat process, so no mod chat's id matches it. */
function fromVSCode(files: Record<string, string>, title: string, folder = CWD) {
  const s = new ChecklistStore()
  s.handleTool(`4242-${folder}`, { cwd: folder }, 'checklist_add_tasks', { title, tasks: [{ text: 'Set the key' }] })
  const c = s.forSession(`4242-${folder}`)!
  const dir = sharedDir(ROOT, folder)
  files[`${dir}/${c.id}.json`] = JSON.stringify(c)
  files[`${dir}/${FOLDER_NOTE}`] = files[`${dir}/${HANDED_NOTE}`] = folder
  return c.id
}

test('a checklist VS Code handed over is picked up from the empty pane with Continue here', async ($, on) => {
  const files: Record<string, string> = { [`${ROOT}/mode.json`]: JSON.stringify({ use: 'mod', at: 1 }) }
  world(on, files)
  const id = fromVSCode(files, 'From VS Code')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No checklist in this chat yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'From VS Code' })).toBeDefined()
  await ui.press({ key: `continue-${id}` })
  expect(await ui.find({ type: 'Text', text: /No checklist in this chat yet/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Set the key' })).toBeDefined()
  await ui.unmount()
  expect(JSON.parse(files[`${sharedDir(ROOT, CWD)}/${id}.json`]!).sessionId).toBe('chat-1')
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toMatch(/Checklist "From VS Code"/)
})

test('switching to the mod in VS Code while a chat is open gives Claude the tools within seconds', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const files: Record<string, string> = { [`${ROOT}/mode.json`]: JSON.stringify({ use: 'extension', at: 1 }) }
  const { seen } = world(on, files)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(seen.tools).toEqual([])
  files[`${ROOT}/mode.json`] = JSON.stringify({ use: 'mod', at: 2 })
  fromVSCode(files, 'From VS Code')
  await clock.advance(3_000)
  expect(seen.tools).toContain(`checklist_add_tasks`)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'From VS Code' })).toBeDefined()
  await ui.unmount()
})

/** A VS Code window file, as the extension writes it. */
const windowFile = (files: Record<string, string>, id: string, port: number, folders: string[], focusedAt = 1) =>
  (files[`${ROOT}/windows/${id}.json`] = JSON.stringify({ windowId: id, port, token: `tok-${id}`, pid: 1, folders, focusedAt, name: id }))

test('after /checklist use-extension, Claude\'s calls in this chat reach the checklist in VS Code', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const { files, net, seen } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  await $.command.run({ command: 'checklist', args: 'use-extension' } as any)

  // Two windows: another project's (used last), and this folder's, whose old file names a closed port first.
  windowFile(files, 'other', 5001, ['/work/Other'], 9)
  windowFile(files, 'stale', 5002, [CWD], 5)
  windowFile(files, 'mine', 5003, ['/work'], 2)
  net.answer[5001] = () => ({ status: 200, text: JSON.stringify({ content: [{ type: 'text', text: 'wrong window' }] }) })
  net.answer[5003] = (route, body) =>
    route === '/poll'
      ? { status: 200, text: JSON.stringify({ events: body.sessionId === 'chat-1' ? ['The user shared t1 from VS Code.'] : [] }) }
      : { status: 200, text: JSON.stringify({ content: [{ type: 'text', text: 'Checklist "Things to do": t1 done. Answers arrive via checklist_read; if only the answer is left, call checklist_wait.' }] }) }
  // 'stale' has the folder itself, but nothing answers on its port, so 'mine' is used.
  const r = textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))
  expect(r).toMatch(/^Checklist "Things to do": t1 done/)
  expect(r).not.toContain('checklist_wait')
  const call = net.posts.find(p => p.url.endsWith('/call'))!
  expect(call.url).toBe('http://127.0.0.1:5003/call')
  expect(call.auth).toBe('Bearer tok-mine')
  expect(call.body).toMatchObject({ sessionId: 'chat-1', tool: 'checklist_read', cwd: CWD, process: { channel: true } })

  // Send now in VS Code reaches Claude here.
  await clock.advance(1_000)
  expect(seen.prompts).toContain('The user shared t1 from VS Code.')
})

test('a change goes to a window that answers, and never to a second one after it may have reached the first', async ($, on) => {
  const { files, net } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  await $.command.run({ command: 'checklist', args: 'use-extension' } as any)
  // No window at all: Claude is told to put it in its reply.
  expect(textOf(await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any))).toMatch(/no VS Code window with it is open/)

  // 'gone' was closed without removing its file (nothing listens on its port): skipped, the change goes to 'b'.
  windowFile(files, 'gone', 6001, [CWD], 3)
  windowFile(files, 'b', 6002, [CWD], 2)
  windowFile(files, 'c', 6003, [CWD], 1)
  const added = (route: string, body: any) => ({ status: 200, text: JSON.stringify({ content: [{ type: 'text', text: body.tool === '__hello' ? 'hi' : 'Added 1 task' }] }) })
  net.answer[6002] = added
  net.answer[6003] = added
  expect(textOf(await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any))).toBe('Added 1 task')
  expect(net.posts.filter(p => p.body.tool === 'checklist_add_tasks').map(p => p.url)).toEqual(['http://127.0.0.1:6002/call'])

  // 'b' answers hello, then drops the change: it may have run, so it isn't sent to 'c' as well.
  net.posts.length = 0
  net.answer[6002] = (route, body) => (body.tool === '__hello' ? added(route, body) : 'drop')
  expect(textOf(await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Three' }] } as any))).toMatch(/may or may not have gone through/)
  expect(net.posts.some(p => p.url.includes(':6003'))).toBe(false)
  // A read is safe to repeat: it moves on to 'c'.
  expect(textOf(await $.tool.call({ tool: `${T}checklist_read` } as any))).toBe('Added 1 task')
})

const said = (text: string) => ({ status: 200, text: JSON.stringify({ content: [{ type: 'text', text }] }) })

test('a chat in VS Code: the window it was started from first, the folder\'s before the last one used, and no wait without an end', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const { files, net, env } = world(on)
  env.CHECKLIST_BRIDGE_WINDOW = 'term'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  await $.command.run({ command: 'checklist', args: 'use-extension' } as any)
  const read = () => $.tool.call({ tool: `${T}checklist_read` } as any).then(textOf)

  // Only another project's window is open: the call falls back to it.
  windowFile(files, 'other', 7001, ['/work/Other'], 9)
  net.answer[7001] = () => said('from other')
  expect(await read()).toBe('from other')
  // This folder's window opens: it is used from now on, though 'other' answered last.
  windowFile(files, 'mine', 7002, [CWD], 1)
  net.answer[7002] = () => said('from mine')
  expect(await read()).toBe('from mine')
  // The window whose terminal the chat was started in comes first of all.
  windowFile(files, 'term', 7003, ['/elsewhere'], 0)
  net.answer[7003] = () => said('from term')
  expect(await read()).toBe('from term')

  // A window that takes a change and never answers: Claude is told after 15 s, not left waiting.
  net.answer[7003] = (_, body) => (body.tool === '__hello' ? said('hi') : 'hang')
  const pending = $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Two' }] } as any)
  await clock.advance(15_000)
  expect(textOf(await pending)).toMatch(/may or may not have gone through/)
})

test('screenshots from VS Code reach Claude as images; a chat with no checklist there does not poll it', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const { files, net, chat } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'checklist', args: 'use-extension' } as any)
  windowFile(files, 'mine', 7101, [CWD], 1)
  net.answer[7101] = route => (route === '/poll' ? { status: 200, text: '{"events":[]}' } : said('ok'))
  // This chat had no checklist when it switched, and hasn't called VS Code: it doesn't poll.
  await clock.advance(3_000)
  expect(net.posts.some(p => p.url.endsWith('/poll'))).toBe(false)
  await $.tool.call({ tool: `${T}checklist_read` } as any)
  // A screenshot VS Code sends inline reaches Claude in the form the model can see.
  net.answer[7101] = () => ({ status: 200, text: JSON.stringify({ content: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }] }) })
  const r = await $.tool.call({ tool: `${T}checklist_read` } as any)
  expect((r as any).result).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }])
  // Now VS Code knows this chat: it polls for Send now.
  await clock.advance(1_000)
  expect(net.posts.some(p => p.url.endsWith('/poll') && p.body.sessionId === chat.sid)).toBe(true)
})

test('what the user is typing survives a change made elsewhere', async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }, { text: 'Two' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 't1-note', text: 'half typed', kind: 'change' })
  // Another chat (or VS Code) changes the file meanwhile; the pane reads it with the next press.
  elsewhere(files, c => (c.tasks[1].text = 'Two, renamed elsewhere'))
  await ui.press({ key: 't1-share-done' })
  await ui.unmount()
  const saved = JSON.parse(files[listFile(files)]!)
  expect(saved.tasks[1].text).toBe('Two, renamed elsewhere')
  expect(saved.tasks[0].shared?.note).toBe('half typed')
})

test('a chat started in a subfolder finds the checklists VS Code handed over for the project', async ($, on) => {
  const files: Record<string, string> = { [`${ROOT}/mode.json`]: JSON.stringify({ use: 'mod', at: 1 }) }
  world(on, files)
  const id = fromVSCode(files, 'From VS Code') // under CWD, the project VS Code has open
  await $.session.start({ cwd: `${CWD}/web/src`, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `continue-${id}` })
  await ui.unmount()
  const saved = JSON.parse(files[`${sharedDir(ROOT, CWD)}/${id}.json`]!)
  expect(saved.sessionId).toBe('chat-1')
  expect(files[`${sharedDir(ROOT, CWD)}/folder.txt`]).toBe(CWD)
  // A new checklist in a folder with none above it is kept in that folder's own, which says where it is for.
  await $.session.start({ cwd: '/elsewhere/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'Here' }] } as any)
  expect(files[`${sharedDir(ROOT, '/elsewhere/proj')}/folder.txt`]).toBe('/elsewhere/proj')
})

test('a folder above the chat that VS Code never handed over is not this chat\'s project', async ($, on) => {
  const files: Record<string, string> = {}
  world(on, files)
  // Another chat once used the folder above (no VS Code handover there).
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'Above', tasks: [{ text: 'Not mine' }] } as any)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(textOf(await $.command.run({ command: 'checklist', args: 'list' } as any).then(r => ({ result: r.text })))).toMatch(/No earlier checklists/)
  await $.tool.call({ tool: `${T}checklist_add_tasks`, title: 'Mine', tasks: [{ text: 'Here' }] } as any)
  expect(files[`${sharedDir(ROOT, CWD)}/${FOLDER_NOTE}`]).toBe(CWD)
})

test('a press after another chat took the checklist over changes nothing, and a paste says why it can\'t', async ($, on) => {
  const { files, seen, clipboard } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }, { text: 'Two' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Shared from somewhere else meanwhile: the paste is refused before it runs, for that reason.
  elsewhere(files, c => (c.tasks[0].shared = { at: Date.now(), done: true, note: '', images: [] }))
  const runs = clipboard.runs.length
  await ui.press({ key: 't1-paste' })
  expect(seen.toasts.at(-1)).toMatch(/already shared/)
  expect(clipboard.runs.length).toBe(runs)
  // Another chat takes the checklist over: this pane's press is refused.
  elsewhere(files, c => (c.sessionId = 'chat-2'))
  const before = files[listFile(files)]
  await ui.press({ key: 't1-share-done' }) // the card still drawn
  expect(seen.toasts.at(-1)).toMatch(/taken over by another chat/)
  expect(files[listFile(files)]).toBe(before)
  await ui.unmount()
})

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any

test('a switch to VS Code first seen as Claude starts a turn still brings Send now from VS Code', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const { files, net, seen } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  // Switched in VS Code; the user types a prompt before the mod's next look at the mode.
  files[`${ROOT}/mode.json`] = JSON.stringify({ use: 'extension', at: 2 })
  windowFile(files, 'mine', 5003, [CWD])
  net.answer[5003] = route => ({ status: 200, text: JSON.stringify(route === '/poll' ? { events: ['Sent from VS Code.'] } : { content: [] }) })
  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections.find(s => s.id === 'checklist-bridge:instructions')?.text).toMatch(/The checklist is in VS Code now/)
  await clock.advance(4_000)
  expect(seen.prompts).toContain('Sent from VS Code.')
})

test('a project under the home folder does not take what a window on the home folder handed over', async ($, on) => {
  const files: Record<string, string> = { [`${ROOT}/mode.json`]: JSON.stringify({ use: 'mod', at: 1 }) }
  world(on, files)
  fromVSCode(files, 'Home window', '/home/u')
  await $.session.start({ cwd: '/home/u/work/other', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'checklist', args: 'list' } as any)).text).toMatch(/No earlier checklists/)
  await $.session.start({ cwd: '/home/u', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'checklist', args: 'list' } as any)).text).toMatch(/1\. Home window/)
})

test('the first start writes down that the mod is on, so VS Code leaves its checklists alone', async ($, on) => {
  const { files, seen } = world(on, { '/home/u/.claude.json': JSON.stringify({ mcpServers: { other: {} } }) })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files[`${ROOT}/mode.json`]!).use).toBe('mod')
  expect(seen.tools).toContain('checklist_read')
})

test('the first start leaves the extension on if it is connected to Claude Code', async ($, on) => {
  const config = { mcpServers: { checklist: { command: 'node', args: ['/home/u/.checklist-bridge/connector/connector.js'] } } }
  const { files, seen, env } = world(on, { '/cfg/.claude.json': JSON.stringify(config) })
  env.CLAUDE_CONFIG_DIR = '/cfg'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files[`${ROOT}/mode.json`]!).use).toBe('extension')
  expect(seen.tools).toEqual([])
})

test('nothing is written down while Claude Code\'s settings can\'t be read', async ($, on) => {
  const { files } = world(on, { '/home/u/.claude.json': '{"mcpServers": {"check' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(`${ROOT}/mode.json` in files).toBe(false)
})

test('a typed screenshot path on a task shared from another chat says why it is not added', async ($, on) => {
  const { files, seen } = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  elsewhere(files, c => (c.tasks[0].shared = { at: Date.now(), done: true, note: '', images: [] }))
  await ui.input({ key: 't1-shot', text: '/home/u/a.png' })
  expect(seen.toasts.at(-1)).toMatch(/already shared/)
  await ui.unmount()
})

test('/checklist continue N takes the one listed as N, even after the order changed', async ($, on) => {
  const { files, chat } = world(on)
  for (const [sid, title] of [['chat-a', 'A'], ['chat-b', 'B']]) {
    chat.sid = sid!
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: `${T}checklist_add_tasks`, title, tasks: [{ text: 'One' }] } as any)
  }
  chat.sid = 'chat-c'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'checklist', args: 'list' } as any)).text).toMatch(/^1\. B[^]*\n2\. A/)
  // Chat A changes its checklist: it would be first in a new list.
  const f = Object.keys(files).find(k => k.endsWith('.json') && JSON.parse(files[k]!).title === 'A')!
  const a = JSON.parse(files[f]!)
  a.updatedAt += 10_000
  files[f] = files[`${f}.bak`] = JSON.stringify(a)
  expect((await $.command.run({ command: 'checklist', args: 'continue 1' } as any)).text).toMatch(/"B" is this chat's checklist now/)
  expect(JSON.parse(files[f]!).sessionId).toBe('chat-a')
})

test('a note longer than its field is shown whole under it as it is typed, and the field grows a line per line', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: `${T}checklist_add_tasks`, tasks: [{ text: 'One' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 't1-note' }))?.props.rows).toBe(1)
  const long = 'the key is in the shared vault under payments, ask Sam for access first'
  await ui.input({ key: 't1-note', text: long, kind: 'change' })
  expect(await ui.find({ type: 'Text', text: long })).toBeDefined()
  await ui.input({ key: 't1-note', text: 'short', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: long })).toBeUndefined()
  await ui.input({ key: 't1-note', text: 'one\ntwo\nthree', kind: 'change' })
  expect((await ui.find({ key: 't1-note' }))?.props.rows).toBe(3)
  await ui.unmount()
})
