// Screenshots are kept as separate image files next to the checklists, written once each,
// so saving a checklist writes a few KB of JSON instead of every screenshot again.
// No `vscode` import, so it can be tested on its own.
//
// On disk a checklist's images look like { id, mime, w, h, stored: true } (no data).
// In memory they are loaded back with their data, so the rest of the extension is unchanged.
// Checklists saved by older versions (data inline) still load, and are converted on their next save.
import * as fs from 'fs';
import * as path from 'path';
import type { Checklist, Img } from './model';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const isImg = (v: any): v is Img =>
  !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.mime === 'string' && typeof v.data === 'string';

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

  /** The checklist as JSON for disk, with each screenshot written to its own file first (once). */
  serialize(c: Checklist): string {
    const pending: Img[] = [];
    const json = JSON.stringify(c, (_k, v) => {
      if (!isImg(v)) return v;
      pending.push(v);
      return { id: v.id, mime: v.mime, w: v.w, h: v.h, stored: true };
    });
    for (const img of pending) this.ensure(c.id, img);
    return json;
  }

  /** Load screenshot data back into a checklist read from disk. Images whose file is missing are dropped. */
  hydrate(c: Checklist) {
    for (const list of imageLists(c)) {
      for (let i = list.length - 1; i >= 0; i--) {
        const img = list[i] as Img & { stored?: boolean };
        if (typeof img.data === 'string' && img.data) continue; // saved by an older version: inline
        const f = this.file(c.id, img);
        try {
          img.data = fs.readFileSync(f).toString('base64');
          delete img.stored;
          this.written.add(f);
        } catch {
          this.log(`A screenshot of "${c.title}" is missing on disk and was removed.`);
          list.splice(i, 1);
        }
      }
    }
  }

  /** Delete image files no checklist refers to any more (removed screenshots, deleted checklists). */
  cleanup(lists: Checklist[]) {
    const keep = new Set<string>();
    for (const c of lists) for (const l of imageLists(c)) for (const img of l) keep.add(path.basename(this.file(c.id, img)));
    let removed = 0;
    for (const n of fs.readdirSync(this.dir)) {
      if (keep.has(n)) continue;
      fs.rmSync(path.join(this.dir, n), { force: true });
      removed++;
    }
    if (removed) this.log(`Removed ${removed} screenshot file${removed === 1 ? '' : 's'} no longer used.`);
  }

  private ensure(listId: string, img: Img) {
    const f = this.file(listId, img);
    if (this.written.has(f)) return;
    if (!fs.existsSync(f)) {
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(img.data, 'base64'));
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
