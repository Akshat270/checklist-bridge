// The mod's checklists: the shared ChecklistStore (lib/model.ts) plus what the hooks need around it.
// No `$` here: a mod's engine calls are made in the hooks themselves (register.tsx). This file says
// what to load, save and show; the hooks do the reading, writing and showing.
//
// The files are the truth, not this copy. Other chats in the same folder, and the VS Code extension when
// the user switches, change them too, so before every change the hooks read the folder again (sync) and
// after it they write what changed (pending, saved). A copy is kept over the file only while it has a
// change of its own that isn't saved yet.
//
// One JSON file per checklist, in the shared folder for this project (lib/handover.ts). A mod can't rename
// or delete files, so a save writes `<id>.json.bak` and then `<id>.json`; if the second write is cut short,
// loading falls back to the backup.
import { absolutePath, ancestors, join, listIds, parseList, sharedDir, type Use } from './lib/handover'
import { ChecklistStore, type Checklist } from './lib/model'

export type Paths = { own?: string; userProfile?: string; home?: string }

/** The user's home folder. On Windows, USERPROFILE is what Node's os.homedir() uses. */
export const homeFrom = (env: Paths) => env.userProfile || env.home || '.'
/** `~/.checklist-bridge`, the same folder the extension uses. */
export const rootFrom = (env: Paths) => env.own || join(homeFrom(env), '.checklist-bridge')

/** A file in the folder listing: its name and when it last changed. */
export type Entry = { name: string; mtimeMs: number }
/** A checklist file to read: its paths, its time, and when it was listed, to remember once it is read. */
export type ToRead = { id: string; main: string; bak: string; mtime: number; at: number }
/** One checklist file as read: its text (or, if that was missing or damaged, its backup's). */
export type Loaded = { id: string; mtime: number; at: number; main?: string; bak?: string }

/**
 * A file read when it was already this old is not read again until its time changes. The margin covers disks
 * that keep file times to the second or two (FAT, some network drives): a write right after a read could
 * otherwise leave the time as it was.
 */
const SETTLED_MS = 5000

/** Images are what Claude may open without asking (see isSharedShot). */
export const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** What one save writes, in order, and the version it saves. */
export type Pending = { id: string; at: number; writes: [string, string][] }

export class App {
  readonly store = new ChecklistStore()
  /** The shared folder this chat's checklists are in (see project). */
  dir: string
  /** The folder `dir` is for: the chat's own, or the one above it that VS Code handed checklists over for. */
  project: string
  /** Changed here, not saved yet. */
  private dirty = new Set<string>()
  /** The version (updatedAt) of each checklist as last read from or written to its file. */
  private known = new Map<string, number>()
  /**
   * Text typed into a note or "something else" and not saved yet, by `<list>/<item>/<field>`. Typing isn't a
   * change to save on its own (it would save at every keystroke), so when the file changes elsewhere and
   * this copy is replaced, what was typed is put back.
   */
  private typed = new Map<string, string>()
  /** Each checklist file's time when we last read it, and when that was: settled files are not read again. */
  private readAt = new Map<string, { mtime: number; at: number }>()

  constructor(
    readonly root: string,
    readonly home: string,
    readonly folder: string,
    public use: Use | undefined,
  ) {
    this.store.host = 'mod'
    this.project = folder
    this.dir = sharedDir(root, folder)
  }

  /**
   * The shared folders to look in, nearest first: this chat's folder's, then each folder's above it. VS Code
   * hands its checklists over under its project folder, which may be above the folder the chat started in.
   */
  candidates(): { folder: string; dir: string }[] {
    return ancestors(this.folder).map(folder => ({ folder, dir: sharedDir(this.root, folder) }))
  }

  /** Uses the shared folder for `folder` (one of candidates()). Only while this chat knows no checklist yet. */
  useProject(folder: string): boolean {
    if (folder === this.project || this.store.all().length || this.unsaved) return false
    this.project = folder
    this.dir = sharedDir(this.root, folder)
    this.known.clear()
    this.readAt.clear()
    return true
  }

  /** On unless the user switched to the VS Code extension. */
  get isOn() {
    return this.use !== 'extension'
  }

  /**
   * From a listing of the folder: the checklists in it, and the files of those to read because they are new
   * or changed since we last read them. Every chat, a tool call or a press each, would otherwise read every
   * checklist ever made in this folder.
   */
  plan(entries: Entry[], now = Date.now()): { present: string[]; read: ToRead[] } {
    const mtime = new Map(entries.map(e => [e.name, e.mtimeMs]))
    const present = listIds(entries.map(e => e.name))
    const read: ToRead[] = []
    for (const id of present) {
      const at = mtime.get(`${id}.json`) ?? mtime.get(`${id}.json.bak`) ?? 0
      const last = this.readAt.get(id)
      if (at > 0 && last?.mtime === at && last.at - at > SETTLED_MS && this.store.get(id)) continue
      read.push({ id, main: join(this.dir, `${id}.json`), bak: join(this.dir, `${id}.json.bak`), mtime: at, at: now })
    }
    return { present, read }
  }

  /**
   * Takes in the folder as it is on disk: `present` the checklists in it, `files` those just read. A checklist
   * whose file changed since we last read or wrote it is replaced by the file's version, unless ours has a
   * newer change not saved yet. One whose file is gone (taken back by VS Code) is dropped. Returns whether
   * anything changed.
   */
  sync(present: string[], files: Loaded[]): boolean {
    // Switched to VS Code: it has taken the checklists, so a change that failed to save here is dropped,
    // never written later over what the user does there.
    if (!this.isOn) this.dirty.clear()
    let changed = false
    const onDisk = new Set(present)
    for (const f of files) {
      const c = parseList(f.main) ?? parseList(f.bak)
      if (!c) continue
      this.readAt.set(f.id, { mtime: f.mtime, at: f.at })
      const mine = this.store.get(c.id)
      if (mine && this.known.get(c.id) === c.updatedAt) continue // unchanged on disk: keep ours, with any typing
      if (mine && this.dirty.has(c.id) && mine.updatedAt > c.updatedAt) continue // ours is newer and still to be saved
      const version = c.updatedAt
      this.store.replace(c) // keeps the file's updatedAt: the version both sides compare
      this.retype(c.id)
      this.known.set(c.id, version)
      this.dirty.delete(c.id)
      changed = true
    }
    for (const c of this.store.all())
      if (!onDisk.has(c.id) && this.known.has(c.id) && !this.dirty.has(c.id)) {
        this.store.forget(c.id)
        this.known.delete(c.id)
        this.readAt.delete(c.id)
        changed = true
      }
    return changed
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

  /**
   * Whether `file` is a screenshot the user shared on this chat's checklist. Claude may open exactly those
   * files without asking (they are usually outside the project, so Claude Code would ask each time).
   */
  isSharedShot(sid: string, file: string): boolean {
    const c = this.current(sid)
    if (!c || !file) return false
    // Only image files, whatever a checklist file says: it is plain JSON that something else could have edited.
    if (!IMAGE.test(file)) return false
    const imgs = [...c.tasks.map(t => t.shared?.images ?? []), ...c.questions.map(q => q.answer?.images ?? [])].flat()
    return imgs.some(i => i.path === file)
  }

  /**
   * Makes an earlier checklist this chat's own: one VS Code handed over (it names its chats differently, so
   * none matches), or another chat's. Returns why not, if it can't.
   */
  takeOver(listId: string, sid: string): string | undefined {
    const c = this.current(sid)
    if (c) return `This chat already has the checklist "${c.title}".`
    const pick = this.store.get(listId)
    if (!pick || pick.closed) return 'That checklist was moved or closed.'
    pick.sessionId = sid // the chat it came from no longer has it: its next checklist call reads this from disk
    this.touch(pick)
    return undefined
  }

  /** A screenshot path the user typed, made absolute so Claude and VS Code can open it from anywhere. */
  addShot(listId: string, itemId: string, typed: string): boolean {
    return this.store.addImagePath(listId, itemId, absolutePath(typed, this.home, this.folder))
  }

  /**
   * The chat's checklist as text, without its times (updatedAt, and lastReadAt, which every read sets):
   * two snapshots differ only if something in it changed.
   */
  snapshot(sid: string): string {
    const c = this.store.forSession(sid)
    return c ? JSON.stringify({ ...c, updatedAt: 0, lastReadAt: 0 }) : ''
  }

  /** What the user types into an item's note, or a question's own answer: kept, not saved yet (see typed). */
  type(listId: string, itemId: string, field: 'note' | 'other', value: string) {
    this.typed.set(`${listId}/${itemId}/${field}`, value)
    this.applyTyped(listId, itemId, field, value)
  }

  private applyTyped(listId: string, itemId: string, field: 'note' | 'other', value: string) {
    const c = this.store.get(listId)
    const t = c?.tasks.find(x => x.id === itemId)
    if (t) {
      if (!t.shared && field === 'note') this.store.setDraft(listId, itemId, { note: value })
      return
    }
    const q = c?.questions.find(x => x.id === itemId)
    if (q && !q.answer) this.store.setAnswerDraft(listId, itemId, field === 'note' ? { note: value } : { other: value })
  }

  /** Puts back what was typed on a checklist after a newer copy replaced it. */
  private retype(listId: string) {
    const c = this.store.get(listId)
    if (!c) return
    const version = c.updatedAt
    for (const [k, v] of this.typed) {
      const [list, item, field] = k.split('/') as [string, string, 'note' | 'other']
      if (list === listId) this.applyTyped(list, item, field, v)
    }
    c.updatedAt = version // still the file's version: putting back what was typed is no change of its own
  }

  /** Marks a checklist as changed; the next save writes it. */
  touch(c: Checklist | undefined) {
    if (!c) return
    c.updatedAt = Math.max(Date.now(), c.updatedAt + 1) // always newer than the file it came from
    this.dirty.add(c.id)
  }

  /** The saves to make: every changed checklist. Each stays changed until saved() says it was written. */
  pending(): Pending[] {
    if (!this.isOn) return [] // VS Code has the checklists now
    const out: Pending[] = []
    for (const id of this.dirty) {
      const c = this.store.get(id)
      if (!c) continue
      const text = JSON.stringify(c)
      out.push({ id, at: c.updatedAt, writes: [[join(this.dir, `${id}.json.bak`), text], [join(this.dir, `${id}.json`), text]] })
    }
    return out
  }

  /** A save was written. If the checklist changed again meanwhile, it stays to be saved. */
  saved(p: Pending) {
    this.known.set(p.id, p.at)
    if (this.store.get(p.id)?.updatedAt !== p.at) return // changed again meanwhile: saved next time
    this.dirty.delete(p.id)
    for (const k of [...this.typed.keys()]) if (k.startsWith(`${p.id}/`)) this.typed.delete(k) // it is in the file now
  }

  /** Whether some change is still not saved (a write failed). */
  get unsaved() {
    return this.dirty.size > 0
  }

  /** The line under the prompt while something waits on the user or for Send now. */
  status(sid: string): string | undefined {
    const c = this.isOn ? this.current(sid) : undefined
    if (!c) return undefined
    const left = c.tasks.filter(t => !t.shared).length + c.questions.filter(q => !q.answer && !q.retired).length
    const fresh = this.store.updateSummary(c, 'line').ids.length
    const parts = [left && `${left} on your checklist`, fresh && `${fresh} shared, not sent`, this.unsaved && 'not saved yet'].filter(Boolean)
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
