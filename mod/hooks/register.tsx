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
import type { Register, Timer } from 'claude-code'

import { App, extensionConnected, homeFrom, rootFrom, type Loaded } from './app'
import { parseAway } from './away'
import { noImage, pasteResult, pasteCommand, platformFrom, type Platform } from './clipboard'
import { FOLDER_NOTE, HANDED_NOTE, imagesDir, join, listIds, modeFile, modeText, parseList, parseMode, parseWindow, rankWindows, tooWide, type WindowInfo } from './lib/handover'
import { MOD_INSTRUCTIONS, MOD_TOOLS, withoutWait, type ToolResult } from './lib/model'
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
const OFF_FOR_CLAUDE =
  'The user switched Checklist Bridge to the VS Code extension, and no VS Code window with it is open. ' +
  'Put the steps or the question in your reply instead.'
/** Claude's instructions while the chat's checklist tools reach the checklist in VS Code. */
const IN_VS_CODE =
  '\n\nThe user has switched Checklist Bridge to its VS Code extension. The checklist is in VS Code now, not in a pane ' +
  'next to this chat: these checklist tools reach it there, and what the user sends from it reaches you as a message.'
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
/**
 * Reading and writing this folder's checklists, and following the mode (made in session.start, used by every
 * hook). `mode` reads mode.json and makes a switch's changes here; `load` does that too.
 */
let disk: { mode: () => Promise<boolean>; load: () => Promise<boolean>; save: () => Promise<boolean> } | undefined
let toolsRegistered = false
/** The checklists /checklist list showed last, in its order: /checklist continue N picks from these. */
let listed: string[] = []
/**
 * Calls to the VS Code window, as the extension's connector makes them (src/connector.ts): Claude's calls in a
 * chat that had the mod's tools before the user switched to VS Code (a chat can't gain the extension's own
 * tools once it has started). Undefined when no window answered; 'lost' when one may have got it and didn't
 * answer, so the call may or may not have run.
 */
let vscode: { post: (route: '/call' | '/poll', body: object, safeToRetry: boolean) => Promise<any> } | undefined
let platform: Platform | undefined
/** Whether this chat's checklist is in VS Code now, so its calls and Send now go through the window. */
let inVSCode = false
/** The timers of the session that started last; a new start stops them, so there is one set at a time. */
let timers: Timer[] = []
/**
 * A block of VS Code's result as a mod tool's result must hold it: text without checklist_wait (this chat has
 * none), and an image in the Messages API's form. The extension answers in MCP's form ({ data, mimeType }),
 * which the model can't see when a mod returns it.
 */
function toModel(c: ToolResult['content'][number]) {
  if (c.type === 'text') return { type: 'text' as const, text: withoutWait(c.text) }
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: c.mimeType, data: c.data } }
}

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
    let noted = ''
    let lookedUp = 0
    app = a
    // The tools stay registered with Claude Code across sessions of the process; the timers are made anew.
    for (const t of timers) t.cancel()
    timers = []
    inVSCode = false
    listed = []
    // Which clipboard tool "Paste screenshot" uses. Windows says so in OS; elsewhere ask uname.
    const os = await $.env.get('OS')
    const uname = os === 'Windows_NT' ? undefined : await $.process.run(['uname', '-s']).catch(() => undefined)
    platform = platformFrom(os, uname?.stdout)
    const caseless = platform !== 'linux' // Windows and macOS disks ignore case
    const registerTools = async () => {
      for (const t of MOD_TOOLS)
        await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
      toolsRegistered = true
    }
    // No choice made yet (no mode.json): the mod is on, unless the VS Code extension is connected to Claude Code
    // (it was there first; /checklist use-mod switches). Written down, so VS Code sees the choice too and leaves
    // the mod's checklists alone. Not when Claude Code's settings can't be read: then nothing is known.
    if (!(await $.fs.exists(modeFile(a.root)))) {
      const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
      const config = await $.fs.read(join(configDir || a.home, '.claude.json')).catch(() => undefined)
      const connected = config === undefined ? undefined : extensionConnected(config)
      if (connected !== undefined) await $.fs.write(modeFile(a.root), modeText(connected ? 'extension' : 'mod')).catch(() => undefined)
    }
    a.use = parseMode(await $.fs.read(modeFile(a.root)).catch(() => undefined))
    disk = {
      // Follows a switch made elsewhere (VS Code, another chat). Returns whether the mode changed.
      mode: async () => {
        const was = a.use
        a.use = parseMode(await $.fs.read(modeFile(a.root)).catch(() => undefined))
        if (a.use === was) return false
        lookedUp = 0 // VS Code may have just handed checklists over
        if (a.isOn) {
          inVSCode = false
          // Switched to the mod from VS Code while this chat was open: Claude gets its checklist tools now.
          if (!toolsRegistered) await registerTools()
        } else {
          if (a.current(await $.session.id())) inVSCode = true // its checklist goes to VS Code, and so do its calls
          a.forgetTyped() // VS Code has the checklists: what was typed here is not put back on them later
        }
        return true
      },
      // The mode and the folder as they are now: only files that changed since they were last read are read,
      // and a backup only when its file is missing or damaged. Returns whether the mode or a checklist changed.
      load: async () => {
        const switched = await disk!.mode()
        // No checklist yet: use the nearest folder with checklists, this chat's own or one above it that VS Code
        // handed its project's over for (the project folder may be above where the chat started). Not every
        // folder above: one another chat happened to use is not this project, and nor is the home folder or a
        // disk's top (as VS Code sees it: sharedDirs). Looked for every half minute.
        if (!a.store.all().length && Date.now() - lookedUp > 30_000) {
          lookedUp = Date.now()
          for (const [i, at] of a.candidates().entries()) {
            if (i > 0 && tooWide(at.folder, a.home, caseless)) break
            if (!(await $.fs.exists(at.dir))) continue
            if (i > 0 && !(await $.fs.exists(join(at.dir, HANDED_NOTE)))) continue
            const names = (await $.fs.list(at.dir)).filter(f => f.kind === 'file').map(f => f.name)
            if (!listIds(names).length) continue
            a.useProject(at.folder)
            break
          }
        }
        const entries = (await $.fs.exists(a.dir)) ? (await $.fs.list(a.dir)).filter(f => f.kind === 'file') : []
        const { present, read } = a.plan(entries)
        const files: Loaded[] = []
        for (const f of read) {
          const main = await $.fs.read(f.main).catch(() => undefined)
          const bak = parseList(main) ? undefined : await $.fs.read(f.bak).catch(() => undefined)
          files.push({ id: f.id, mtime: f.mtime, at: f.at, main, bak })
        }
        return a.sync(present, files) || switched
      },
      // Writes every unsaved change. One that fails stays unsaved and is tried again next time.
      save: async () => {
        let ok = true
        const pending = a.pending()
        for (const p of pending) {
          try {
            for (const [file, text] of p.writes) await $.fs.write(file, text)
            a.saved(p)
          } catch {
            ok = false
          }
        }
        // Says which folder this shared folder is for, so VS Code finds it when the chat is in a subfolder.
        if (ok && pending.length && noted !== a.dir) {
          const wrote = await $.fs.write(join(a.dir, FOLDER_NOTE), a.project).then(
            () => true,
            () => false,
          )
          if (wrote) noted = a.dir // otherwise tried again with the next save
        }
        return ok
      },
    }
    await disk.load()


    await $.command.register({
      name: 'checklist',
      description: 'This chat\'s checklist of tasks and decisions for you',
      argumentHint: '[away 2h | back | list | use-extension]',
    })
    // While the user has switched to the VS Code extension, a new chat gets the extension's tools instead.
    if (a.isOn) await registerTools()

    // How this chat finds its VS Code window, as the connector does (registry.ts): the window whose terminal it
    // was started in, the one Claude Code's VS Code integration is connected to, then by folder (rankWindows).
    const ssePort = await $.env.get('CLAUDE_CODE_SSE_PORT')
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || join(a.home, '.claude')
    const ideLock = ssePort ? await $.fs.read(join(configDir, 'ide', `${ssePort}.lock`)).catch(() => undefined) : undefined
    const hints = {
      envWindow: await $.env.get('CHECKLIST_BRIDGE_WINDOW'),
      idePid: (() => {
        try {
          const pid = JSON.parse(ideLock ?? '').pid
          return typeof pid === 'number' ? pid : undefined
        } catch {
          return undefined
        }
      })(),
      cwd: a.folder,
      caseless,
    }
    /** One request to a window, or why there is no answer: 'none' (nothing there) or 'late' (no answer in time). */
    const ask = (w: WindowInfo, route: string, body: object, ms: number) =>
      new Promise<{ status: number; text: string } | 'none' | 'late'>(resolve => {
        const stop = $.clock.after(ms, () => resolve('late'))
        $.http
          .fetch(`http://127.0.0.1:${w.port}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${w.token}` },
            body: JSON.stringify(body),
          })
          .then(
            r => (stop.cancel(), resolve(r)),
            () => (stop.cancel(), resolve('none')),
          )
      })
    // The window that answered last is kept while no better one is there, as the connector stays with its window.
    let lastWindow = ''
    vscode = {
      post: async (route, body, safeToRetry) => {
        const dir = join(a.root, 'windows')
        const names = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json')).map(f => f.name) : []
        const wins: WindowInfo[] = []
        for (const n of names) {
          const w = parseWindow(await $.fs.read(join(dir, n)).catch(() => undefined))
          if (w) wins.push(w)
        }
        const ranked = rankWindows(wins, hints)
        const top = ranked[0]?.rank
        ranked.sort((x, y) => Number(y.rank === top && y.w.windowId === lastWindow) - Number(x.rank === top && x.w.windowId === lastWindow))
        for (const { w } of ranked) {
          // A change is sent only to a window that just answered: a window file can outlive its window, and a
          // change that may have reached one can't be tried on the next (it would happen twice).
          if (!safeToRetry) {
            const hello = await ask(w, '/call', { ...body, tool: '__hello', args: {} }, 5_000)
            if (typeof hello === 'string' || hello.status !== 200) continue
          }
          const r = await ask(w, route, body, route === '/poll' ? 40_000 : 15_000)
          if (typeof r === 'string') {
            if (!safeToRetry) return 'lost'
            continue
          }
          if (r.status !== 200) continue // refused before running: an old token, or another program on that port
          lastWindow = w.windowId
          try {
            return JSON.parse(r.text)
          } catch {
            return undefined
          }
        }
        return undefined
      },
    }

    // While this chat's checklist is in VS Code: its Send now reaches Claude here as a message. The window holds
    // each poll until it has something (at most 25 s), as it does for the connector. Only a chat that has its
    // checklist there polls: the window counts a polling chat as one it can reach.
    let polling = false
    let quietUntil = 0
    timers.push(
      $.clock.every(1_000, async () => {
        if (polling || a.isOn || !toolsRegistered || !inVSCode || Date.now() < quietUntil) return
        polling = true
        try {
          const r = await vscode!.post('/poll', { sessionId: await $.session.id(), process: { ancestors: [], channel: true } }, true)
          if (!r) quietUntil = Date.now() + 5_000 // no window: look again in a few seconds
          for (const text of Array.isArray(r?.events) ? r.events : []) if (typeof text === 'string') void $.prompt.submit({ text })
        } finally {
          polling = false
        }
      }),
    )

    // Every few seconds: follow a switch made in VS Code, take in what other chats or VS Code changed, count
    // down an away, and end it when its time is up (Claude already stops treating the user as away then; this
    // clears the pane and saves). Files that didn't change are not read again, so this stays cheap.
    timers.push($.clock.every(3_000, async () => {
      const sid = await $.session.id()
      const changed = await disk!.load()
      const c = a.isOn ? a.current(sid) : undefined
      if (c?.awayUntil && c.awayUntil <= Date.now() && a.store.endAway(c.id)) {
        a.touch(c)
        await disk!.save()
      }
      if (changed || c?.awayUntil || a.unsaved) {
        if (a.unsaved) await disk!.save() // a write that failed earlier
        await update($, rev, n => n + 1)
      }
    }))
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
    if (!app || !disk) return r
    if (await disk.mode()) await update($, rev, n => n + 1)
    // Switched to VS Code: a chat with the mod's tools keeps them (they reach VS Code); a new one has none.
    if (!toolsRegistered) return r
    const text = MOD_INSTRUCTIONS + (app.isOn ? '' : IN_VS_CODE)
    return { sections: [...r.sections, { id: 'checklist-bridge:instructions', text, scope: 'session' as const }] }
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
    const { tool, tool_use_id: _, ...args } = e as { tool: string; tool_use_id: string } & Record<string, unknown>
    const sid = await $.session.id()
    if (!a.isOn) {
      // Switched to VS Code: the checklist is there now, so the call goes to its window.
      const name = tool.slice(PREFIX.length)
      const body = { sessionId: sid, cwd: a.folder, client: 'claude', tool: name, args, process: { ancestors: [], channel: true } }
      const r: ToolResult | 'lost' | undefined = await vscode!.post('/call', body, name === 'checklist_read')
      if (r === 'lost')
        return {
          result: `VS Code did not answer in time, so this ${name} call may or may not have gone through. Call checklist_read to see the checklist before trying again.`,
          isError: true,
        }
      if (!r || !Array.isArray(r.content)) return { result: OFF_FOR_CLAUDE }
      inVSCode = true // the window knows this chat now: its Send now can reach it here
      const content = r.content.map(toModel)
      return { result: content, ...(r.isError ? { isError: true } : {}) }
    }
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
    if (typeof file === 'string' && app?.isOn && app.isSharedShot(await $.session.id(), file)) return { decision: 'allow' as const }
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
      // Follows the switch (the tools, if this chat started without them), and reads what VS Code handed over.
      await disk!.load()
      void $.ui.open({ id: PANE, title: 'Checklist' })
      out =
        'Checklist Bridge now runs here in Claude Code. If VS Code is open, it moves its checklists here in a few seconds: ' +
        'press "Continue here" on the one you want in the checklist pane.'
    } else if (!a.isOn) {
      out = OFF_FOR_USER
    } else if (sub === 'use-extension') {
      await disk!.save() // everything goes over as it is now
      await $.fs.write(modeFile(a.root), modeText('extension'))
      a.use = 'extension'
      a.forgetTyped()
      inVSCode = !!c
      out = [
        'Switched to the VS Code extension.',
        'Open this folder in VS Code. Checklist Bridge brings these checklists over and connects Claude again.',
        `No extension yet? Install it from ${INSTALL_EXTENSION}`,
        'Claude in this chat keeps using the checklist there once VS Code is open.',
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
      // N is a number from the list the user was shown, as the order changes when other chats update theirs.
      // Nothing listed yet in this chat: the list as it is now.
      const shown = listed.length ? listed : others.slice(0, 9).map(o => o.id)
      const wanted = sub === 'continue' ? shown[Number(rest[0]) - 1] : undefined
      const pick = wanted ? others.find(o => o.id === wanted) : undefined
      if (sub === 'list') {
        listed = others.slice(0, 9).map(o => o.id)
        out = others.length
          ? others
              .slice(0, 9)
              .map((o, i) => `${i + 1}. ${o.title}: ${o.tasks.filter(t => !t.shared).length} tasks waiting (${new Date(o.updatedAt).toLocaleString()})`)
              .join('\n') + '\n\nRun /checklist continue N to make one this chat\'s checklist.'
          : 'No earlier checklists in this folder.'
      } else if (!wanted) out = 'Run /checklist list, then /checklist continue with the number of the one you want.'
      else if (!pick) out = 'That checklist was closed or taken by another chat since. Run /checklist list to see them as they are now.'
      else {
        const refused = a.takeOver(pick.id, sid)
        if (!refused) {
          listed = [] // that list is out of date now: the next N counts in the list as it is then
          void $.ui.open({ id: PANE, title: 'Checklist' })
        }
        out = refused ?? `"${pick.title}" is this chat's checklist now. Claude sees it the next time it reads the checklist.`
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
        const gone = a.refusal(listId, sid)
        if (gone) {
          a.forgetTyped(listId) // another chat's now: not put back on it if it comes back here
          await update($, rev, n => n + 1)
          return void $.ui.toast(gone)
        }
        const refused = change()
        if (refused) return void $.ui.toast(refused)
        a.touch(a.store.get(listId))
        await done()
      },
      toast: text => void $.ui.toast(text),
      redraw: () => void update($, rev, n => n + 1),
      focus: key => void $.ui.focus({ requestId: PANE, key }).catch(() => undefined),
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
        await d.load()
        const before = a.isOn ? a.refusal(c.id, sid, itemId) : OFF_FOR_USER
        if (before) return void $.ui.toast(before)
        // The system's own tool writes the PNG (a mod can't write binary files). Its folder must exist first.
        const dir = imagesDir(a.root)
        await $.fs.write(join(dir, '.keep'), '')
        const file = join(dir, `${c.id}-${itemId}-${Date.now().toString(36)}.png`)
        const r = await $.process.run(pasteCommand(p), { env: { CB_SHOT: file }, timeoutMs: 20_000 }).catch(() => undefined)
        const result = pasteResult(r?.stdout)
        if (result !== 'ok') return void $.ui.toast(noImage(p, result))
        // Changed meanwhile? Then the image stays unused, and VS Code's tidying deletes it after 30 days.
        await d.load()
        const after = a.isOn ? a.refusal(c.id, sid, itemId) : OFF_FOR_USER
        if (after) return void $.ui.toast(after)
        if (!a.store.addImagePath(c.id, itemId, file)) return void $.ui.toast('That is not a .png, .jpg, .gif or .webp file.')
        a.touch(a.store.get(c.id))
        await done()
        void $.ui.toast('Screenshot added.')
      },
      open: async taskId => {
        await update($, openTask, () => taskId)
      },
      continueHere: async listId => {
        await d.load()
        if (!a.isOn) return void $.ui.toast(OFF_FOR_USER)
        const refused = a.takeOver(listId, sid)
        if (refused) {
          await update($, rev, n => n + 1)
          return void $.ui.toast(refused)
        }
        await done()
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
