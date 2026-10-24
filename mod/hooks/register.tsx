// Checklist Bridge as a Claude Code mod: the checklist runs inside Claude Code, no VS Code needed.
// Glue only. The checklist itself is lib/model.ts, the same code the VS Code extension runs.
//
// Only one of the mod and the extension is on at a time (lib/handover.ts). When the user has switched
// to the extension, the mod's tools say so and the pane says how to switch back.
//
// The files on disk are the truth (see app.ts): every change, from Claude, the pane, a command or the
// away timer, first reads the mode and this folder's checklists again (`disk.load`), then makes the
// change, then writes it (`disk.save`). A mod spells every engine call as $.noun.call(...) inside a hook,
// so those two are made once, in session.start, and every hook after uses them.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { App, homeFrom, rootFrom, type Loaded } from './app'
import { parseAway } from './away'
import { noImage, pasteResult, pasteCommand, platformFrom, type Platform } from './clipboard'
import { imagesDir, join, modeFile, modeText, parseList, parseMode } from './lib/handover'
import { MOD_INSTRUCTIONS, MOD_TOOLS } from './lib/model'
import { drawPane } from './pane'
import { palette } from './theme'

const PANE = 'checklist'
// Goes up on every change, so the pane redraws.
const rev = atom({ plugin: 'checklist-bridge', key: 'rev' } as const, 0)
// What the pane shows: the task whose card is open ('' for the next task), and the shared section.
const openTask = atom({ plugin: 'checklist-bridge', key: 'openTask' } as const, '')
const showShared = atom({ plugin: 'checklist-bridge', key: 'showShared' } as const, false)
const awayPicker = atom({ plugin: 'checklist-bridge', key: 'awayPicker' } as const, false)
const PREFIX = 'mcp__checklist-bridge__'
const TOOL_NAMES = new Set(MOD_TOOLS.map(t => PREFIX + t.name))
const INSTALL_EXTENSION = 'https://marketplace.visualstudio.com/items?itemName=Akshat270.checklist-bridge'
const OFF_FOR_CLAUDE = 'The user switched Checklist Bridge to the VS Code extension. Put the steps or the question in your reply instead.'
const OFF_FOR_USER = 'Your checklists are in the VS Code extension now. To use them here again, type /checklist use-mod.'
const NOT_SAVED = 'Checklist Bridge could not save the checklist just now. It tries again with the next change.'

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
/** Reading and writing this folder's checklists (made in session.start, used by every hook). */
let disk: { load: () => Promise<boolean>; save: () => Promise<boolean> } | undefined
let toolsRegistered = false
let platform: Platform | undefined

export const register: Register = (on, options) => {
  // /config › Colors: the pane's palette, for a dark or a light terminal theme.
  const colors = palette(options.colors)

  on('session.start', async ($, e, next) => {
    const paths = {
      own: await $.env.get('CHECKLIST_BRIDGE_HOME'),
      userProfile: await $.env.get('USERPROFILE'),
      home: await $.env.get('HOME'),
    }
    const a = new App(rootFrom(paths), homeFrom(paths), e.cwd, undefined)
    app = a
    disk = {
      // The mode and the folder as they are now: only files that changed since they were last read are read,
      // and a backup only when its file is missing or damaged. Returns whether any checklist changed.
      load: async () => {
        a.use = parseMode(await $.fs.read(modeFile(a.root)).catch(() => undefined))
        const entries = (await $.fs.exists(a.dir)) ? (await $.fs.list(a.dir)).filter(f => f.kind === 'file') : []
        const { present, read } = a.plan(entries)
        const files: Loaded[] = []
        for (const f of read) {
          const main = await $.fs.read(f.main).catch(() => undefined)
          const bak = parseList(main) ? undefined : await $.fs.read(f.bak).catch(() => undefined)
          files.push({ id: f.id, mtime: f.mtime, at: f.at, main, bak })
        }
        return a.sync(present, files)
      },
      // Writes every unsaved change. One that fails stays unsaved and is tried again next time.
      save: async () => {
        let ok = true
        for (const p of a.pending()) {
          try {
            for (const [file, text] of p.writes) await $.fs.write(file, text)
            a.saved(p)
          } catch {
            ok = false
          }
        }
        return ok
      },
    }
    await disk.load()

    // Which clipboard tool "Paste screenshot" uses. Windows says so in OS; elsewhere ask uname.
    const os = await $.env.get('OS')
    const uname = os === 'Windows_NT' ? undefined : await $.process.run(['uname', '-s']).catch(() => undefined)
    platform = platformFrom(os, uname?.stdout)

    await $.command.register({
      name: 'checklist',
      description: 'This chat\'s checklist of tasks and decisions for you',
      argumentHint: '[away 2h | back | list | use-extension]',
    })
    // While the user has switched to the VS Code extension, Claude gets the extension's tools instead.
    if (a.isOn) {
      for (const t of MOD_TOOLS)
        await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
      toolsRegistered = true
    }

    // Every half minute: take in what other chats or VS Code changed, count down an away, and end it when
    // its time is up (Claude already stops treating the user as away then; this clears the pane and saves).
    $.clock.every(30_000, async () => {
      const changed = await disk!.load()
      const c = a.isOn ? a.current(await $.session.id()) : undefined
      if (c?.awayUntil && c.awayUntil <= Date.now() && a.store.endAway(c.id)) {
        a.touch(c)
        await disk!.save()
      }
      if (changed || c?.awayUntil || a.unsaved) {
        if (a.unsaved) await disk!.save() // a write that failed earlier
        await update($, rev, n => n + 1)
      }
    })
    return next(e)
  })

  // Anything not saved yet is written before the session ends, unless the user switched to VS Code meanwhile.
  on('session.end', async ($, e, next) => {
    await disk?.load()
    await disk?.save()
    return next(e)
  })

  // Claude's instructions, while the mod is on. The mode is read each time: the user may have switched.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!app) return r
    app.use = parseMode(await $.fs.read(modeFile(app.root)).catch(() => undefined))
    if (!app.isOn) return r
    return { sections: [...r.sections, { id: 'checklist-bridge:instructions', text: MOD_INSTRUCTIONS, scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    const a = app
    if (!a || !disk || !TOOL_NAMES.has(e.tool)) {
      // The extension's own tools, if it is still connected after switching to the mod.
      if (a?.use === 'mod' && e.tool.startsWith('mcp__checklist__'))
        return { deny: 'Checklist Bridge runs as a Claude Code mod now. Use the mcp__checklist-bridge__ checklist tools instead.' }
      return next(e)
    }
    await disk.load()
    if (!a.isOn) return { result: OFF_FOR_CLAUDE }
    const { tool, tool_use_id: _, ...args } = e as { tool: string; tool_use_id: string } & Record<string, unknown>
    const sid = await $.session.id()
    const had = a.current(sid)
    // Saved only if the call changed something: a read with nothing new, or a refused call, writes nothing
    // (other chats and VS Code would read the file again for nothing).
    const was = a.snapshot(sid)
    const res = a.store.handleTool(sid, { cwd: a.folder, client: 'claude' }, tool.slice(PREFIX.length), args)
    if (a.snapshot(sid) !== was) a.touch(a.store.forSession(sid))
    const saved = await disk.save()
    await update($, rev, n => n + 1)
    $.ui.status(a.status(sid))
    if (!had && a.current(sid)) void $.ui.open({ id: PANE, title: 'Checklist' })
    // The change is made either way: say it isn't saved yet, rather than failing the call (Claude would
    // make it again).
    const content = saved ? res.content : [...res.content, { type: 'text' as const, text: NOT_SAVED }]
    // A tool's result reaches Claude as a string or a list of content blocks.
    return { result: content, ...(res.isError ? { isError: true } : {}) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Checklist Bridge could not handle this call.' }))

  // Claude opens the screenshots the user shared without a permission question each time: exactly those
  // files, nothing else in their folder. Anything else goes on to Claude Code's own decision.
  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    const file = (e.input as { file_path?: unknown } | undefined)?.file_path
    if (app?.isOn && typeof file === 'string' && app.isSharedShot(await $.session.id(), file)) return { decision: 'allow' as const }
    return next(e)
  })

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const a = app!
    await disk!.load()
    const sid = await $.session.id()
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const sub = word.toLowerCase()
    const c = a.current(sid)
    let out: string

    if (sub === 'use-mod') {
      await $.fs.write(modeFile(a.root), modeText('mod'))
      a.use = 'mod'
      // What VS Code handed over since this chat started.
      await disk!.load()
      if (!toolsRegistered) {
        for (const t of MOD_TOOLS)
          await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
        toolsRegistered = true
      }
      void $.ui.open({ id: PANE, title: 'Checklist' })
      out =
        'Checklist Bridge now runs here in Claude Code. If the VS Code extension is still connected, open VS Code and run ' +
        '"Checklist Bridge: Use the Claude Code mod instead" so Claude only sees one checklist.'
    } else if (!a.isOn) {
      out = OFF_FOR_USER
    } else if (sub === 'use-extension') {
      await disk!.save() // everything goes over as it is now
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
      else if (!a.store.setAway(c.id, away.ms, away.label, away.midnightIn)) out = 'Say how long, like /checklist away 2h, 45m or 18:30 (up to 24 hours).'
      else {
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
        // The chat it came from no longer has it: its next checklist call reads this from disk.
        pick.sessionId = sid
        a.touch(pick)
        void $.ui.open({ id: PANE, title: 'Checklist' })
        out = `"${pick.title}" is this chat's checklist now. Claude sees it the next time it reads the checklist.`
      }
    } else if (sub === '' || sub === 'open') {
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'Checklist' })
      out = isPlaced ? 'Checklist opened.' : 'The checklist could not be shown here. Try a wider window.'
    } else out = HELP

    if (!(await disk!.save())) out += `\n${NOT_SAVED}`
    await update($, rev, n => n + 1)
    $.ui.status(a.status(sid))
    return { text: out }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    await read($, rev)
    const a = app
    const d = disk
    if (!a || !d) return <els.Text dimColor>Loading…</els.Text>
    const sid = await $.session.id()
    const p = platform ?? 'linux'
    const view = {
      openId: await read($, openTask),
      showShared: await read($, showShared),
      awayPicker: await read($, awayPicker),
      width: e.props.bodyColumns,
      colors,
    }
    /** After a change: save it, redraw, and say so if it couldn't be saved. */
    const done = async () => {
      if (!(await d.save())) void $.ui.toast(NOT_SAVED)
      await update($, rev, n => n + 1)
      $.ui.status(a.status(sid))
    }
    return drawPane(els, a, sid, view, {
      edit: async (listId, change) => {
        await d.load()
        if (!a.isOn) {
          await update($, rev, n => n + 1)
          return void $.ui.toast(OFF_FOR_USER)
        }
        if (!a.store.get(listId)) {
          await update($, rev, n => n + 1)
          return void $.ui.toast('That checklist was moved or taken over by another chat.')
        }
        const refused = change()
        if (refused) return void $.ui.toast(refused)
        a.touch(a.store.get(listId))
        await done()
      },
      toast: text => void $.ui.toast(text),
      send: async c => {
        await d.load()
        const fresh = a.isOn ? a.store.get(c.id) : undefined
        const text = fresh && a.sendNow(fresh)
        if (!text) return void $.ui.toast(a.isOn ? 'Nothing new to send. Share a task or answer a question first.' : OFF_FOR_USER)
        await done()
        void $.prompt.submit({ text })
        void $.ui.toast('Sent to Claude.')
      },
      paste: async (c, itemId) => {
        // The system's own tool writes the PNG (a mod can't write binary files). Its folder must exist first.
        const dir = imagesDir(a.root)
        await $.fs.write(join(dir, '.keep'), '')
        const file = join(dir, `${c.id}-${itemId}-${Date.now().toString(36)}.png`)
        const r = await $.process.run(pasteCommand(p), { env: { CB_SHOT: file }, timeoutMs: 20_000 }).catch(() => undefined)
        const result = pasteResult(r?.stdout)
        if (result !== 'ok') return void $.ui.toast(noImage(p, result))
        await d.load()
        if (!a.isOn) return void $.ui.toast(OFF_FOR_USER)
        if (!a.store.addImagePath(c.id, itemId, file)) return void $.ui.toast('This one already has 8 screenshots.')
        a.touch(a.store.get(c.id))
        await done()
        void $.ui.toast('Screenshot added.')
      },
      open: async taskId => {
        await update($, openTask, () => taskId)
      },
      toggleShared: async () => {
        await update($, showShared, v => !v)
      },
      toggleAwayPicker: async () => {
        await update($, awayPicker, v => !v)
      },
      copy: async (text, surface) => {
        const r = await $.ui.copy({ text, surface })
        void $.ui.toast(r.isCopied ? 'Copied.' : 'Could not copy here. Select the command and copy it yourself.')
      },
    })
  })
}
