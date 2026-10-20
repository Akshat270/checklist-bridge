// Copied from src/handover.ts by scripts/copy-mod-lib.js. Do not edit here: edit src/handover.ts and run npm run build.
// Switching between the VS Code extension and the Claude Code mod. No `vscode` and no Node imports:
// the extension and the mod (mod/, which runs a copy of this file) each pass in their own file access.
//
// Only one of the two is on at a time. `<root>/mode.json` says which. The mod keeps its checklists in
// `<root>/mod/<folder key>/<id>.json`, one folder per project, and that is also where the extension
// hands its checklists over: when switching to the mod it writes them there, and when switching back
// it takes them in and renames the files to `<id>.json.moved`.
//
// The mod can only write text files, so in the shared folder a screenshot is a path to an image file.
import { normalize, type Checklist, type Img } from './model';

export type Use = 'extension' | 'mod';

/** What mode.json says, or undefined if it's missing or unreadable. */
export function parseMode(text: string | undefined): Use | undefined {
  try {
    const use = JSON.parse(text ?? '')?.use;
    return use === 'extension' || use === 'mod' ? use : undefined;
  } catch {
    return undefined;
  }
}

export const modeText = (use: Use, now = Date.now()) => JSON.stringify({ use, at: now }) + '\n';

/** 32-bit FNV-1a, as 8 hex digits. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * The shared folder's name for a project folder: readable, and the same from VS Code and from Claude.
 * Windows paths are compared without case and with either slash.
 */
export function folderKey(folder: string): string {
  let p = folder.trim().replace(/\\/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (/^[A-Za-z]:/.test(p) || p.startsWith('//')) p = p.toLowerCase();
  const name = (p.split('/').filter(Boolean).pop() ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, 40);
  return `${name || 'folder'}-${fnv(p)}`;
}

/** Joins with forward slashes, which Node and Claude Code both take on Windows too. */
export const join = (first: string, ...rest: string[]) =>
  [first.replace(/[\\/]+$/, ''), ...rest.map((p) => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join('/');

export const modeFile = (root: string) => join(root, 'mode.json');
export const sharedDir = (root: string, folder: string) => join(root, 'mod', folderKey(folder));
export const imagesDir = (root: string) => join(root, 'mod', 'images');

/** The checklist ids in a shared folder listing: `<id>.json` files, not the `.bak` or `.moved` ones. */
export function listIds(names: string[]): string[] {
  return names.filter((n) => /^[A-Za-z0-9-]+\.json$/.test(n)).map((n) => n.slice(0, -5));
}

/** Reads a checklist file, or undefined if it isn't one. */
export function parseList(text: string | undefined): Checklist | undefined {
  try {
    const c = JSON.parse(text ?? '');
    return c && typeof c.id === 'string' && Array.isArray(c.tasks) ? normalize(c) : undefined;
  } catch {
    return undefined;
  }
}

function eachImageList(c: Checklist, fn: (imgs: Img[]) => Img[]) {
  for (const t of c.tasks) {
    t.draft.images = fn(t.draft.images ?? []);
    if (t.shared) t.shared.images = fn(t.shared.images ?? []);
  }
  for (const q of c.questions) {
    q.draft.images = fn(q.draft.images ?? []);
    if (q.answer) q.answer.images = fn(q.answer.images ?? []);
  }
}

/**
 * A copy of an extension checklist for the shared folder. `saveImage` writes a screenshot to a file and
 * returns its path (or undefined if it couldn't); screenshots that can't be saved are left out.
 */
export function toShared(c: Checklist, saveImage: (img: Img) => string | undefined): Checklist {
  const copy: Checklist = JSON.parse(JSON.stringify(c));
  eachImageList(copy, (imgs) =>
    imgs.flatMap((img) => {
      const p = img.path ?? saveImage(img);
      return p ? [{ id: img.id, mime: img.mime, w: img.w, h: img.h, path: p }] : [];
    })
  );
  return copy;
}

/**
 * A shared checklist made ready for the extension. `readImage` returns a file's base64 data (or undefined);
 * screenshots whose file is gone are left out.
 */
export function fromShared(c: Checklist, readImage: (path: string) => string | undefined): Checklist {
  const copy: Checklist = JSON.parse(JSON.stringify(c));
  eachImageList(copy, (imgs) =>
    imgs.flatMap((img) => {
      if (!img.path) return img.data || img.stored ? [img] : [];
      const data = readImage(img.path);
      return data ? [{ id: img.id, mime: img.mime, w: img.w, h: img.h, data }] : [];
    })
  );
  return normalize(copy);
}
