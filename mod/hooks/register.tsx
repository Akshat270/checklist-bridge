// Checklist Bridge as a Claude Code mod: the checklist runs inside Claude Code, no VS Code needed.
// Glue only. The checklist itself is lib/model.ts, the same code the VS Code extension runs.
//
// Only one of the mod and the extension is on at a time (lib/handover.ts). When the user has switched
// to the extension, the mod's tools say so and the pane says how to switch back.
//
// A mod spells every engine call as $.noun.call(...) inside its hook, so each hook below saves with
// `for (const [p, t] of app.flush()) await $.fs.write(p, t)` after it changes something.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { App, filesToLoad, rootFrom } from './app'
import { parseAway } from './away'
import { modeFile, modeText, parseMode, sharedDir } from './lib/handover'
import { MOD_INSTRUCTIONS, MOD_TOOLS } from './lib/model'
import { drawPane } from './pane'

const PANE = 'checklist'
// Goes up on every change, so the pane redraws.
const rev = atom({ plugin: 'checklist-bridge', key: 'rev' } as const, 0)
const PREFIX = 'mcp__checklist-bridge__'
const TOOL_NAMES = new Set(MOD_TOOLS.map(t => PREFIX + t.name))
const INSTALL_EXTENSION = 'https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge'

const HELP = [
  '/checklist                 open this chat\'s checklist',
  '/checklist away 2h         tell Claude you are away (also 45m, 18:30, 6:30pm)',
  '/checklist back            you are back',
  '/checklist list            earlier checklists in this folder',
  '/checklist continue N      make earlier checklist N this chat\'s',
  '/checklist use-extension   switch to the VS Code extension',
  '/checklist use-mod         switch back to this mod',
].join('\n')

let app: App | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const root = rootFrom({
      own: await $.env.get('CHECKLIST_BRIDGE_HOME'),
      userProfile: await $.env.get('USERPROFILE'),
      home: await $.env.get('HOME'),
    })
    const mode = (await $.fs.exists(modeFile(root))) ? await $.fs.read(modeFile(root)).catch(() => undefined) : undefined
    const loaded: (string | undefined)[][] = []
    const dir = sharedDir(root, e.cwd)
    if (await $.fs.exists(dir)) {
      const names = (await $.fs.list(dir)).filter(f => f.kind === 'file').map(f => f.name)
      for (const f of filesToLoad(dir, names))
        loaded.push([await $.fs.read(f.main).catch(() => undefined), await $.fs.read(f.bak).catch(() => undefined)])
    }
    app = new App(root, e.cwd, parseMode(mode), loaded)

    await $.command.register({
      name: 'checklist',
      description: 'This chat\'s checklist of tasks and decisions for you',
      argumentHint: '[away 2h | back | list | use-extension]',
    })
    // While the user has switched to the VS Code extension, Claude gets the extension's tools instead.
    if (app.isOn)
      for (const t of MOD_TOOLS)
        await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
    return next(e)
  })

  // Claude's instructions, while the mod is on.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!app?.isOn) return r
    return { sections: [...r.sections, { id: 'checklist-bridge:instructions', text: MOD_INSTRUCTIONS, scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    if (!app || !TOOL_NAMES.has(e.tool)) {
      // The extension's own tools, if it is still connected after switching to the mod.
      if (app?.use === 'mod' && e.tool.startsWith('mcp__checklist__'))
        return { deny: 'Checklist Bridge runs as a Claude Code mod now. Use the mcp__checklist-bridge__ checklist tools instead.' }
      return next(e)
    }
    if (!app.isOn) {
      const off = 'The user switched Checklist Bridge to the VS Code extension. Put the steps or the question in your reply instead.'
      return { result: off }
    }
    const { tool, tool_use_id: _, ...args } = e as { tool: string; tool_use_id: string } & Record<string, unknown>
    const sid = await $.session.id()
    const had = app.current(sid)
    const res = app.store.handleTool(sid, { cwd: app.folder, client: 'claude' }, tool.slice(PREFIX.length), args)
    app.touch(app.store.forSession(sid))
    for (const [p, t] of app.flush()) await $.fs.write(p, t)
    await update($, rev, n => n + 1)
    $.ui.status(app.status(sid))
    if (!had && app.current(sid)) void $.ui.open({ id: PANE, title: 'Checklist' })
    // A tool's result reaches Claude as a string or a list of content blocks.
    return { result: res.content, ...(res.isError ? { isError: true } : {}) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Checklist Bridge could not handle this call.' }))

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const a = app!
    const sid = await $.session.id()
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const sub = word.toLowerCase()
    const c = a.current(sid)
    let out: string

    if (sub === 'use-mod') {
      await $.fs.write(modeFile(a.root), modeText('mod'))
      a.use = 'mod'
      for (const t of MOD_TOOLS)
        await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
      void $.ui.open({ id: PANE, title: 'Checklist' })
      out =
        'Checklist Bridge now runs here in Claude Code. If the VS Code extension is still connected, open VS Code and run ' +
        '"Checklist Bridge: Use the Claude Code mod instead" so Claude only sees one checklist.'
    } else if (!a.isOn) {
      out = 'Your checklists are in the VS Code extension now. To use them here again, run /checklist use-mod.'
    } else if (sub === 'use-extension') {
      await $.fs.write(modeFile(a.root), modeText('extension'))
      a.use = 'extension'
      out = [
        'Switched to the VS Code extension.',
        'Open this folder in VS Code. Checklist Bridge brings these checklists over and connects Claude again.',
        `No extension yet? Install it from ${INSTALL_EXTENSION}`,
        'Start a new Claude chat afterwards so it uses the extension.',
      ].join('\n')
    } else if (sub === 'away') {
      const away = parseAway(rest.join(' '))
      if (!away) out = 'Say how long, like /checklist away 2h, 45m or 18:30 (up to 24 hours).'
      else if (!c) out = 'This chat has no checklist yet.'
      else {
        a.store.setAway(c.id, away.ms, away.label)
        a.touch(c)
        out = `Claude knows you are away until ${away.label}. It will do what it can without you and leave the rest on the checklist.`
      }
    } else if (sub === 'back') {
      if (c && a.store.endAway(c.id)) {
        a.touch(c)
        out = 'Welcome back. Claude knows you are here again.'
      } else out = 'You were not marked as away.'
    } else if (sub === 'list' || sub === 'continue') {
      const others = a.others(sid)
      const pick = sub === 'continue' ? others[Number(rest[0]) - 1] : undefined
      if (!others.length) out = 'No earlier checklists in this folder.'
      else if (sub === 'list')
        out =
          others
            .slice(0, 9)
            .map((o, i) => `${i + 1}. ${o.title}: ${o.tasks.filter(t => !t.shared).length} tasks waiting (${new Date(o.updatedAt).toLocaleString()})`)
            .join('\n') + '\n\nRun /checklist continue N to make one this chat\'s checklist.'
      else if (!pick) out = 'Run /checklist list, then /checklist continue with the number of the one you want.'
      else if (c) out = `This chat already has the checklist "${c.title}".`
      else {
        pick.sessionId = sid
        a.touch(pick)
        void $.ui.open({ id: PANE, title: 'Checklist' })
        out = `"${pick.title}" is this chat's checklist now. Claude sees it the next time it reads the checklist.`
      }
    } else if (sub === '' || sub === 'open') {
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'Checklist' })
      out = isPlaced ? 'Checklist opened.' : 'The checklist could not be shown here. Try a wider window.'
    } else out = HELP

    for (const [p, t] of a.flush()) await $.fs.write(p, t)
    await update($, rev, n => n + 1)
    $.ui.status(a.status(sid))
    return { text: out }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    await read($, rev)
    const a = app
    if (!a) return <els.Text dimColor>Loading…</els.Text>
    const sid = await $.session.id()
    return drawPane(els, a, sid, {
      changed: async c => {
        a.touch(c)
        for (const [p, t] of a.flush()) await $.fs.write(p, t)
        await update($, rev, n => n + 1)
        $.ui.status(a.status(sid))
      },
      toast: text => void $.ui.toast(text),
      send: async c => {
        const text = a.sendNow(c)
        if (!text) return void $.ui.toast('Nothing new to send. Share a task or answer a question first.')
        for (const [p, t] of a.flush()) await $.fs.write(p, t)
        await update($, rev, n => n + 1)
        $.ui.status(a.status(sid))
        void $.prompt.submit({ text })
        void $.ui.toast('Sent to Claude.')
      },
    })
  })
}
