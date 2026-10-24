// The extension's side of switching to the Claude Code mod and back (the rules are in handover.ts).
// No `vscode` import, so it can be tested on its own.
import * as fs from 'fs';
import * as path from 'path';
import { fromShared, imagesDir, listIds, modeFile, modeText, parseList, parseMode, sharedDir, toShared, type Use } from './handover';
import { ImageFiles } from './images';
import type { Checklist, Img } from './model';
import { writeFileSafe } from './saver';

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
 * be written doesn't stop the others: it is named in `failed`.
 */
export function exportLists(root: string, folder: string, lists: Checklist[], images: ImageSource): { written: number; failed: string[] } {
  const dir = sharedDir(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const out = new ImageFiles(imagesDir(root)); // the same file names as the extension's own
  const failed: string[] = [];
  let written = 0;
  for (const c of lists) {
    try {
      const copy = toShared(c, (img) => {
        const target = out.file(c.id, img);
        try {
          writeFileSafe(target, img.data ? Buffer.from(img.data, 'base64') : fs.readFileSync(images.file(c.id, img)));
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
      failed.push(c.title);
    }
  }
  return { written, failed };
}

/**
 * The checklists the mod has for this project, ready for the extension (screenshots read back in), and
 * the ids of every file read, closed checklists too, for markMoved.
 */
export function importLists(root: string, folder: string): { lists: Checklist[]; ids: string[] } {
  const dir = sharedDir(root, folder);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { lists: [], ids: [] };
  }
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return undefined;
    }
  };
  const readImage = (p: string) => {
    try {
      return fs.readFileSync(p).toString('base64');
    } catch {
      return undefined;
    }
  };
  const lists: Checklist[] = [];
  const ids = listIds(names);
  for (const id of ids) {
    const c = parseList(read(`${id}.json`)) ?? parseList(read(`${id}.json.bak`));
    if (c && !c.closed) lists.push(fromShared(c, readImage));
  }
  return { lists, ids };
}

/** After taking checklists in: rename their files so they aren't taken in again. */
export function markMoved(root: string, folder: string, ids: string[]) {
  const dir = sharedDir(root, folder);
  for (const id of ids)
    for (const f of [`${id}.json`, `${id}.json.bak`]) {
      try {
        fs.rmSync(path.join(dir, `${f}.moved`), { force: true }); // Windows can't rename over a file
        fs.renameSync(path.join(dir, f), path.join(dir, `${f}.moved`));
      } catch {
        /* already gone */
      }
    }
}

/** Whether the mod has checklists for this project waiting to be taken in. */
export function hasShared(root: string, folder: string): boolean {
  try {
    return listIds(fs.readdirSync(sharedDir(root, folder))).length > 0;
  } catch {
    return false;
  }
}
