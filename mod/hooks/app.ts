// The mod's checklists: the shared ChecklistStore (lib/model.ts) plus what the hooks need around it.
// No `$` here: a mod's engine calls are made in the hooks themselves (register.tsx). This file says
// what to save and what to show; the hooks do the saving and showing.
//
// Checklists are saved one JSON file each in the shared folder for this project (lib/handover.ts).
// A mod can't rename or delete files, so a save writes `<id>.json.bak` and then `<id>.json`; if the
// second write is cut short, loading falls back to the backup.
import { join, listIds, parseList, sharedDir, type Use } from './lib/handover'
import { ChecklistStore, type Checklist } from './lib/model'

/** `~/.checklist-bridge`, the same folder the extension uses. On Windows, USERPROFILE is what Node's os.homedir() uses. */
export const rootFrom = (env: { own?: string; userProfile?: string; home?: string }) =>
  env.own || join(env.userProfile || env.home || '.', '.checklist-bridge')

/** The files to read for a folder listing, each with its backup. */
export const filesToLoad = (dir: string, names: string[]) =>
  listIds(names).map(id => ({ main: join(dir, `${id}.json`), bak: join(dir, `${id}.json.bak`) }))

export class App {
  readonly store = new ChecklistStore()
  readonly dir: string
  private dirty = new Set<string>()

  constructor(
    readonly root: string,
    readonly folder: string,
    public use: Use | undefined,
    loaded: (string | undefined)[][],
  ) {
    this.store.host = 'mod'
    this.dir = sharedDir(root, folder)
    for (const [main, bak] of loaded) {
      const c = parseList(main) ?? parseList(bak)
      if (c) this.store.adopt(c)
    }
  }

  /** On unless the user switched to the VS Code extension. */
  get isOn() {
    return this.use !== 'extension'
  }

  current(sid: string): Checklist | undefined {
    const c = this.store.forSession(sid)
    return c && !c.closed ? c : undefined
  }

  /** Earlier checklists in this folder, newest first: other chats', still open. */
  others(sid: string): Checklist[] {
    return this.store
      .all()
      .filter(c => c.sessionId !== sid && !c.closed)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Marks a checklist as changed; the next flush() saves it. */
  touch(c: Checklist | undefined) {
    if (!c) return
    c.updatedAt = Date.now()
    this.dirty.add(c.id)
  }

  /** The writes that save every changed checklist, in order: [path, text]. */
  flush(): [string, string][] {
    const out: [string, string][] = []
    for (const id of this.dirty) {
      const c = this.store.get(id)
      if (!c) continue
      const text = JSON.stringify(c)
      out.push([join(this.dir, `${id}.json.bak`), text], [join(this.dir, `${id}.json`), text])
    }
    this.dirty.clear()
    return out
  }

  /** The line under the prompt while something waits on the user or for Send now. */
  status(sid: string): string | undefined {
    const c = this.isOn ? this.current(sid) : undefined
    if (!c) return undefined
    const left = c.tasks.filter(t => !t.shared).length + c.questions.filter(q => !q.answer && !q.retired).length
    const fresh = this.store.updateSummary(c, 'line').ids.length
    const parts = [left && `${left} on your checklist`, fresh && `${fresh} shared, not sent`].filter(Boolean)
    return parts.length ? `${parts.join(', ')} (/checklist)` : undefined
  }

  /**
   * "Send now": the message that hands Claude what the user shared and it hasn't read, or undefined if
   * there is nothing new. Marks it as sent, so pressing twice doesn't send it twice.
   */
  sendNow(c: Checklist): string | undefined {
    const { text, ids } = this.store.updateSummary(c, 'full')
    if (!ids.length) return undefined
    this.store.markPushed(c.id, ids)
    this.touch(c)
    return text
  }
}
