// Screenshots are kept as separate image files next to the checklists, written once each,
// so saving a checklist writes a few KB of JSON instead of every screenshot again.
// No `vscode` import, so it can be tested on its own.
//
// On disk a checklist's images look like { id, mime, w, h, stored: true } (no data). They stay that way
// in memory too: the panel shows them straight from their files, and their data is read only when
// Claude asks for them (load). New screenshots carry their data until their file is written.
// Checklists saved by older versions (data inline) still load, and are converted on their next save.
import * as fs from 'fs';
import * as path from 'path';
import type { Checklist, Img } from './model';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A screenshot object, with its data (new or old-format) or stored on disk. */
export const isImg = (v: any): v is Img =>
  !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.mime === 'string' && (typeof v.data === 'string' || v.stored === true);

/** Every image array in a checklist (drafts, shared tasks, answers). */
function imageLists(c: Checklist): Img[][] {
  const out: Img[][] = [];
  for (const t of c.tasks ?? []) {
    if (t.draft?.images) out.push(t.draft.images);
    if (t.shared?.images) out.push(t.shared.images);
  }
  for (const q of c.questions ?? []) {
    if (q.draft?.images) out.push(q.draft.images);
    if (q.answer?.images) out.push(q.answer.images);
  }
  return out;
}

export class ImageFiles {
  private written = new Set<string>();

  constructor(readonly dir: string, private log: (s: string) => void = () => {}) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Where an image is stored. Names are built only from ids we generate, never from user input. */
  file(listId: string, img: Pick<Img, 'id' | 'mime'>) {
    const safe = (s: string) => s.replace(/[^\w-]/g, '_');
    return path.join(this.dir, `${safe(listId)}-${safe(img.id)}.${EXT[img.mime] ?? 'bin'}`);
  }

  /** True once the image is on disk (so the panel can load it from the file). */
  has(listId: string, img: Img) {
    return this.written.has(this.file(listId, img));
  }

  /** The checklist as JSON for disk, with each new screenshot written to its own file first (once). */
  serialize(c: Checklist): string {
    const pending: Img[] = [];
    const json = JSON.stringify(c, (_k, v) => {
      if (!isImg(v)) return v;
      if (typeof v.data === 'string') pending.push(v);
      return { id: v.id, mime: v.mime, w: v.w, h: v.h, stored: true };
    });
    for (const img of pending) this.ensure(c.id, img);
    return json;
  }

  /**
   * Prepare a checklist read from disk, without reading screenshot data: stored screenshots are
   * checked to exist and stay on disk until needed. Images whose file is missing are dropped.
   */
  index(c: Checklist) {
    for (const list of imageLists(c)) {
      for (let i = list.length - 1; i >= 0; i--) {
        const img = list[i];
        if (typeof img.data === 'string' && img.data) continue; // saved by an older version: inline, converted on save
        const f = this.file(c.id, img);
        if (fs.existsSync(f)) {
          img.stored = true;
          this.written.add(f);
        } else {
          this.log(`A screenshot of "${c.title}" is missing on disk and was removed.`);
          list.splice(i, 1);
        }
      }
    }
  }

  /** A stored screenshot's data (base64), read when Claude needs it. */
  load(listId: string, img: Img): string | undefined {
    try {
      return fs.readFileSync(this.file(listId, img)).toString('base64');
    } catch {
      return undefined;
    }
  }

  /**
   * Delete screenshot files that no checklist file refers to (removed screenshots, deleted checklists).
   * `keepIds` is every checklist that has a file on disk, readable or not, so a checklist that fails
   * to load (or belongs to another window) keeps its screenshots.
   */
  cleanup(lists: Checklist[], keepIds: Iterable<string> = []) {
    const keep = new Set<string>();
    for (const c of lists) for (const l of imageLists(c)) for (const img of l) keep.add(path.basename(this.file(c.id, img)));
    const prefixes = [...keepIds].map((id) => `${id.replace(/[^\w-]/g, '_')}-`);
    const loaded = new Set(lists.map((c) => `${c.id.replace(/[^\w-]/g, '_')}-`));
    const recent = Date.now() - 60_000;
    let removed = 0;
    for (const n of fs.readdirSync(this.dir)) {
      if (keep.has(n)) continue;
      const f = path.join(this.dir, n);
      // Another window may be writing this one right now.
      if (n.endsWith('.tmp') && fs.statSync(f).mtimeMs > recent) continue;
      // A checklist we couldn't load (or don't own) keeps all its screenshots.
      const p = prefixes.find((x) => n.startsWith(x));
      if (p && !loaded.has(p)) continue;
      fs.rmSync(f, { force: true });
      removed++;
    }
    if (removed) this.log(`Removed ${removed} screenshot file${removed === 1 ? '' : 's'} no longer used.`);
  }

  private ensure(listId: string, img: Img) {
    const f = this.file(listId, img);
    if (this.written.has(f)) return;
    if (!fs.existsSync(f)) {
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(img.data ?? '', 'base64'));
      try {
        fs.renameSync(tmp, f);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        if (!fs.existsSync(f)) throw e;
      }
    }
    this.written.add(f);
  }
}
