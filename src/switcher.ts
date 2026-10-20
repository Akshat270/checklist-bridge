// The extension's side of switching to the Claude Code mod and back (the rules are in handover.ts).
// No `vscode` import, so it can be tested on its own.
import * as fs from 'fs';
import * as path from 'path';
import { fromShared, imagesDir, listIds, modeFile, modeText, parseList, parseMode, sharedDir, toShared, type Use } from './handover';
import type { Checklist, Img } from './model';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function readUse(root: string): Use | undefined {
  try {
    return parseMode(fs.readFileSync(modeFile(root), 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeUse(root: string, use: Use) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(modeFile(root), modeText(use));
}

/**
 * Writes the checklists into the mod's folder for this project, each screenshot as an image file.
 * `imageData` gives a screenshot's base64 data. Returns how many were written.
 */
export function exportLists(root: string, folder: string, lists: Checklist[], imageData: (listId: string, img: Img) => string | undefined): number {
  const dir = sharedDir(root, folder);
  const imgDir = imagesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });
  for (const c of lists) {
    const copy = toShared(c, (img) => {
      const data = img.data ?? imageData(c.id, img);
      if (!data) return undefined;
      const safe = (s: string) => s.replace(/[^\w-]/g, '_');
      const file = path.join(imgDir, `${safe(c.id)}-${safe(img.id)}.${EXT[img.mime] ?? 'png'}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    });
    const text = JSON.stringify(copy);
    fs.writeFileSync(path.join(dir, `${c.id}.json.bak`), text);
    fs.writeFileSync(path.join(dir, `${c.id}.json`), text);
  }
  return lists.length;
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
