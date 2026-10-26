// The extension's side of switching to the Claude Code mod and back (the rules are in handover.ts).
// No `vscode` import, so it can be tested on its own.
import * as fs from 'fs';
import * as path from 'path';
import { FOLDER_NOTE, HANDED_NOTE, fromShared, imagesDir, isInside, listIds, modeFile, modeText, parseList, parseMode, sharedDir, toShared, type Use } from './handover';
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
 * than ours (the mod has changed it since an earlier handover) is left as the mod has it.
 */
export function exportLists(root: string, folder: string, lists: Checklist[], images: ImageSource): { written: number; failed: Checklist[] } {
  const dir = sharedDir(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeFileSafe(path.join(dir, FOLDER_NOTE), folder);
    writeFileSafe(path.join(dir, HANDED_NOTE), folder);
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
      return fs.readFileSync(p).toString('base64');
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

/**
 * After taking checklists in: rename the files of those read (`seen`, from importLists) so they aren't taken
 * in again, retrying while Windows has one open (the mod reading it). One the mod saved again since it was
 * read is left, to be taken in next (`changed`), so that save isn't moved away unread. `stuck` are the
 * files that could not be renamed.
 */
export function markMoved(dir: string, seen: Record<string, number>): { changed: string[]; stuck: string[] } {
  const changed: string[] = [];
  const stuck: string[] = [];
  for (const [id, version] of Object.entries(seen)) {
    if (readList(dir, id)?.updatedAt !== version) {
      changed.push(id);
      continue;
    }
    for (const f of [`${id}.json`, `${id}.json.bak`]) {
      const from = path.join(dir, f);
      for (let attempt = 0; ; attempt++) {
        try {
          fs.rmSync(`${from}.moved`, { force: true }); // Windows can't rename over a file
          fs.renameSync(from, `${from}.moved`);
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

/**
 * The mod's shared folders a window takes checklists back from: each of its folders' own, and those of mod
 * chats started in a subfolder of one (their FOLDER_NOTE says where), unless they are another's:
 * - one VS Code handed over (HANDED_NOTE) belongs to the window on that folder;
 * - a subfolder another open window is nearer to (it has that subfolder, or one between, open) is that window's;
 * - a window on the home folder or a drive's top takes only its own folder's, not every project below it.
 * `others` are the folders of the other open VS Code windows. Without case on Windows and macOS.
 */
export function sharedDirs(root: string, folders: string[], others: string[] = [], home = ''): string[] {
  const caseless = process.platform !== 'linux';
  const dirs = new Set(folders.map((f) => path.resolve(sharedDir(root, f))));
  const modDir = path.dirname(imagesDir(root));
  const tooWide = (f: string) => path.resolve(f) === path.resolve(f, '..') || (!!home && isInside(home, f, caseless));
  let names: string[] = [];
  try {
    names = fs.readdirSync(modDir);
  } catch {
    /* nothing handed over yet */
  }
  for (const name of names) {
    const dir = path.resolve(modDir, name);
    if (dirs.has(dir) || fs.existsSync(path.join(dir, HANDED_NOTE))) continue;
    let at: string;
    try {
      at = fs.readFileSync(path.join(dir, FOLDER_NOTE), 'utf8').trim();
    } catch {
      continue;
    }
    const mine = folders.filter((f) => at && !tooWide(f) && isInside(at, f, caseless));
    if (!mine.length) continue;
    const depth = Math.max(...mine.map((f) => f.length));
    if (others.some((f) => isInside(at, f, caseless) && f.length > depth)) continue;
    dirs.add(dir);
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
