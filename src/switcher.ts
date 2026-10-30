// The extension's side of switching to the Claude Code mod and back (the rules are in handover.ts).
// No `vscode` import, so it can be tested on its own.
import * as fs from 'fs';
import * as path from 'path';
import { FOLDER_NOTE, HANDED_NOTE, fromShared, handedBy, handedNote, imagesDir, isInside, listIds, modeFile, modeText, parseList, parseMode, sharedDir, toShared, tooWide, type Use } from './handover';
import { ImageFiles } from './images';
import type { Checklist, Img } from './model';
import { LOCKED, sleepSync, writeFileSafe } from './saver';

export function readUse(root: string): Use | undefined {
  try {
    return parseMode(fs.readFileSync(modeFile(root), 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeUse(root: string, use: Use) {
  fs.mkdirSync(root, { recursive: true });
  writeFileSafe(modeFile(root), modeText(use));
}

/** Where the extension keeps a checklist's screenshots: its image files (ImageFiles). */
export interface ImageSource {
  /** A stored screenshot's file. */
  file(listId: string, img: Img): string;
}

/**
 * Writes the checklists into the mod's folder for this project, each screenshot copied to an image file
 * the mod can point Claude at. Saved like Saver saves (temp file, then rename). One checklist that can't
 * be written doesn't stop the others: it is in `failed`. A checklist whose file in the mod's folder is newer
 * than ours (the mod has changed it since an earlier handover) is left as the mod has it. `windowId` is the
 * window handing them over: it takes them back.
 */
export function exportLists(root: string, folder: string, lists: Checklist[], images: ImageSource, windowId: string): { written: number; failed: Checklist[] } {
  const dir = sharedDir(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeFileSafe(path.join(dir, FOLDER_NOTE), folder);
    writeFileSafe(path.join(dir, HANDED_NOTE), handedNote(folder, windowId));
  } catch {
    /* only needed to match subfolders to this folder */
  }
  const out = new ImageFiles(imagesDir(root)); // the same file names as the extension's own
  const failed: Checklist[] = [];
  let written = 0;
  for (const c of lists) {
    try {
      const there = readList(dir, c.id);
      if (there && there.updatedAt > c.updatedAt) {
        written++; // already with the mod, and newer
        continue;
      }
      const copy = toShared(c, (img) => {
        const target = out.file(c.id, img);
        try {
          // Named by checklist and screenshot, which never changes: one copied at an earlier handover is kept.
          if (!fs.existsSync(target)) writeFileSafe(target, img.data ? Buffer.from(img.data, 'base64') : fs.readFileSync(images.file(c.id, img)));
          return target;
        } catch {
          return undefined; // its file is gone: the screenshot is left out
        }
      });
      const text = JSON.stringify(copy);
      writeFileSafe(path.join(dir, `${c.id}.json.bak`), text);
      writeFileSafe(path.join(dir, `${c.id}.json`), text);
      written++;
    } catch {
      failed.push(c);
    }
  }
  return { written, failed };
}

/** A checklist in the mod's folder, from its file or else its backup. */
function readList(dir: string, id: string): Checklist | undefined {
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return undefined;
    }
  };
  return parseList(read(`${id}.json`)) ?? parseList(read(`${id}.json.bak`));
}

/**
 * The checklists in one of the mod's shared folders that `want` takes, ready for the extension (screenshots
 * read back in; closed ones too, as closing one in the mod must close it here), and the version of each one
 * read (`seen`), for markMoved.
 */
export function importLists(dir: string, want: (c: Checklist) => boolean = () => true): { lists: Checklist[]; seen: Record<string, number> } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { lists: [], seen: {} };
  }
  const readImage = (p: string) => {
    try {
      const b = fs.readFileSync(p);
      return isImage(b) ? b.toString('base64') : undefined;
    } catch {
      return undefined;
    }
  };
  const lists: Checklist[] = [];
  const seen: Record<string, number> = {};
  for (const id of listIds(names)) {
    const c = readList(dir, id);
    if (!c) continue; // being written: taken next time
    seen[id] = c.updatedAt;
    if (want(c)) lists.push(fromShared(c, readImage)); // screenshots read only for those taken in
  }
  return { lists, seen };
}

/** Whether a file's bytes are a PNG, JPEG, GIF or WebP image, whatever its name says. */
function isImage(b: Buffer): boolean {
  const at = (i: number, text: string) => b.subarray(i, i + text.length).toString('latin1') === text;
  return at(0, '\x89PNG') || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || at(0, 'GIF8') || (at(0, 'RIFF') && at(8, 'WEBP'));
}

/**
 * After taking checklists in: rename the files of those read (`seen`, from importLists) so they aren't taken
 * in again, retrying while Windows has one open (the mod reading it). One the mod saved again since it was
 * read is left, to be taken in next (`changed`), so that save isn't moved away unread: it is looked at before
 * the rename, and the moved files after it, for a save that landed in between. `stuck` are the files that
 * could not be renamed.
 */
export function markMoved(dir: string, seen: Record<string, number>): { changed: string[]; stuck: string[] } {
  const changed: string[] = [];
  const stuck: string[] = [];
  const version = (f: string) => {
    try {
      return parseList(fs.readFileSync(path.join(dir, f), 'utf8'))?.updatedAt;
    } catch {
      return undefined;
    }
  };
  for (const [id, seenAt] of Object.entries(seen)) {
    if (readList(dir, id)?.updatedAt !== seenAt) {
      changed.push(id);
      continue;
    }
    const moved: string[] = [];
    for (const f of [`${id}.json`, `${id}.json.bak`]) {
      const from = path.join(dir, f);
      for (let attempt = 0; ; attempt++) {
        try {
          fs.rmSync(`${from}.moved`, { force: true }); // Windows can't rename over a file
          fs.renameSync(from, `${from}.moved`);
          moved.push(f);
          break;
        } catch (e: any) {
          if (e?.code === 'ENOENT') break; // already gone (a checklist with only one of the two)
          if (!LOCKED.has(e?.code) || attempt >= 5) {
            stuck.push(from);
            break;
          }
          sleepSync(50);
        }
      }
      try {
        // A rename keeps the file's time: stamp when it was moved, which tidyShared counts its 30 days from.
        const now = new Date();
        if (fs.existsSync(`${from}.moved`)) fs.utimesSync(`${from}.moved`, now, now);
      } catch {
        /* kept a little less long */
      }
    }
    // A save between the look above and the rename was moved with it: put it back, unless the mod has
    // written that file again since (then the new one is newer still). Copied, not renamed, so it can't
    // land on top of such a write.
    let late = false;
    for (const f of moved) {
      if (!((version(`${f}.moved`) ?? 0) > seenAt)) continue; // an older backup is no save
      late = true;
      try {
        fs.copyFileSync(path.join(dir, `${f}.moved`), path.join(dir, f), fs.constants.COPYFILE_EXCL);
      } catch {
        /* written again meanwhile */
      }
    }
    if (late) changed.push(id);
  }
  return { changed, stuck };
}

/** How long `.moved` files and screenshot copies no checklist uses are kept, in case they are wanted back. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes what the shared folders no longer need, once it is older than KEEP_MS: `.moved` files, and
 * screenshots in `mod/images` that no checklist file there names (the `.moved` ones still kept included).
 * Screenshots elsewhere (paths the user typed) are never touched. Returns how many files it deleted.
 */
export function tidyShared(root: string, now = Date.now()): number {
  const modDir = path.dirname(imagesDir(root));
  const imgs = imagesDir(root);
  const old = (p: string) => {
    try {
      return now - fs.statSync(p).mtimeMs > KEEP_MS;
    } catch {
      return false;
    }
  };
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  const gone = (p: string) => {
    try {
      fs.rmSync(p, { force: true });
      return 1;
    } catch {
      return 0;
    }
  };
  // Windows and macOS disks ignore case, and the two sides may spell the home folder differently.
  const key = (p: string) => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());
  let n = 0;
  const used = new Set<string>();
  for (const name of list(modDir)) {
    const dir = path.join(modDir, name);
    if (path.resolve(dir) === path.resolve(imgs)) continue;
    for (const f of list(dir)) {
      const p = path.join(dir, f);
      if (f.endsWith('.moved') && old(p)) {
        n += gone(p);
        continue;
      }
      // A .moved file kept for now still counts: its screenshots stay with it.
      if (!/\.json(\.bak)?(\.moved)?$/.test(f)) continue;
      let text: string | undefined;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        // can't tell what it uses: keep every screenshot
        return n;
      }
      const c = parseList(text);
      if (!c) continue;
      for (const t of c.tasks) for (const i of [...t.draft.images, ...(t.shared?.images ?? [])]) if (i.path) used.add(key(i.path));
      for (const q of c.questions) for (const i of [...q.draft.images, ...(q.answer?.images ?? [])]) if (i.path) used.add(key(i.path));
    }
  }
  for (const f of list(imgs)) {
    const p = path.join(imgs, f);
    if (!used.has(key(p)) && old(p)) n += gone(p);
  }
  return n;
}

/** An open VS Code window, for sharedDirs: its id and its folders. */
export interface OpenWindow {
  id: string;
  folders: string[];
}

/**
 * The mod's shared folders window `me` takes checklists back from: each of its folders' own, and those of mod
 * chats started in a subfolder of one (their FOLDER_NOTE says where). Each shared folder goes to one window,
 * the open window (of `me` and `others`) nearest to it:
 * - one VS Code handed over (HANDED_NOTE) goes only to a window on that same folder;
 * - a subfolder goes to the window with the deepest folder it is in;
 * - a window on the home folder or a disk's top takes only its own folder's, not every project below it;
 * - two windows on the same folder: the one that handed it over, else the one whose id sorts first.
 * Without case on Windows and macOS.
 */
export function sharedDirs(root: string, me: OpenWindow, others: OpenWindow[] = [], home = ''): string[] {
  const caseless = process.platform !== 'linux';
  const norm = (f: string) => {
    const s = f.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return caseless ? s.toLowerCase() : s;
  };
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  const all = [me, ...others];
  /** The window that takes back the shared folder for `at`. */
  const owner = (at: string, handed: string | undefined) => {
    let best: { w: OpenWindow; depth: number } | undefined;
    for (const w of all)
      for (const f of w.folders) {
        const same = norm(f) === norm(at);
        if (!same && (handed !== undefined || tooWide(f, home, caseless) || !isInside(at, f, caseless))) continue;
        const depth = norm(f).length;
        const wins =
          !best ||
          depth > best.depth ||
          (depth === best.depth && best.w.id !== handed && (w.id === handed || w.id < best.w.id));
        if (wins) best = { w, depth };
      }
    return best?.w;
  };
  const modDir = path.dirname(imagesDir(root));
  let names: string[] = [];
  try {
    names = fs.readdirSync(modDir);
  } catch {
    /* nothing handed over yet */
  }
  const dirs = new Set<string>();
  const seen = new Set<string>();
  const consider = (dir: string, at: string | undefined) => {
    dir = path.resolve(dir);
    if (seen.has(dir) || !at) return;
    seen.add(dir);
    const note = read(path.join(dir, HANDED_NOTE));
    const handed = note === undefined ? undefined : handedBy(note) ?? '';
    if (owner(at, handed) === me) dirs.add(dir);
  };
  for (const f of me.folders) consider(sharedDir(root, f), f);
  for (const name of names) {
    const dir = path.join(modDir, name);
    if (path.resolve(dir) !== path.resolve(imagesDir(root))) consider(dir, read(path.join(dir, FOLDER_NOTE))?.trim());
  }
  return [...dirs];
}

/**
 * Whether the mod has checklists in this shared folder waiting to be taken in. `stuck` are files that
 * could not be moved before, with their times: they count again only once they change.
 */
export function hasShared(dir: string, stuck: Map<string, number> = new Map()): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return listIds(names).some((id) =>
    [`${id}.json`, `${id}.json.bak`].some((f) => {
      const p = path.join(dir, f);
      try {
        const t = fs.statSync(p).mtimeMs;
        return stuck.get(p) !== t;
      } catch {
        return false;
      }
    })
  );
}
