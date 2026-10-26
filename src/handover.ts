// Switching between the VS Code extension and the Claude Code mod. No `vscode` and no Node imports:
// the extension and the mod (mod/, which runs a copy of this file) each pass in their own file access.
//
// Only one of the two is on at a time. `<root>/mode.json` says which. The mod keeps its checklists in
// `<root>/mod/<folder key>/<id>.json`, one folder per project, and that is also where the extension
// hands its checklists over: when switching to the mod it writes them there, and when switching back
// it takes them in and renames the files to `<id>.json.moved`. While the mod has them, the extension's own
// copies are read-only, and the mod reads the folder again before every change, so neither side's older
// copy can be saved over the other's newer one.
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
 * Paths are compared with either slash and without case: Windows and macOS disks ignore case, and the
 * two sides may spell the same folder differently (VS Code's path, the terminal's `cd`).
 * On Linux, where case matters, `/src/App` and `/src/app` share a folder: their checklists are kept apart by
 * chat, so this only lists one project's earlier checklists under the other's /checklist list.
 */
export function folderKey(folder: string): string {
  let p = folder.trim().replace(/\\/g, '/').toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const name = (p.split('/').filter(Boolean).pop() ?? '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, 40);
  return `${name || 'folder'}-${fnv(p)}`;
}

/** Joins with forward slashes, which Node and Claude Code both take on Windows too. */
export const join = (first: string, ...rest: string[]) =>
  [first.replace(/[\\/]+$/, ''), ...rest.map((p) => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join('/');

export const modeFile = (root: string) => join(root, 'mode.json');
/**
 * In each shared folder: the project folder it is for, as text. Folder keys are hashes, so this is how VS Code
 * finds the checklists a mod chat made in a subfolder of its project.
 */
export const FOLDER_NOTE = 'folder.txt';
/**
 * In a shared folder VS Code handed checklists over to: the window's project folder. The folder belongs to
 * that window: a mod chat in a subfolder uses it, and only a window on that same folder takes it back.
 */
export const HANDED_NOTE = 'from-vscode.txt';

/** A path's own folder and each folder above it, nearest first: `/a/b` gives `/a/b`, `/a`, `/`. */
export function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = p.trim().replace(/[\\/]+$/, '') || p.trim();
  if (/^[A-Za-z]:$/.test(cur)) cur += '\\';
  for (;;) {
    out.push(cur);
    const cut = cur.replace(/[\\/][^\\/]*$/, '');
    // The top: '/' (cut is ''), or a drive like 'C:' (cut has no slash left).
    const up = cut === '' ? (cur.startsWith('/') && cur !== '/' ? '/' : undefined) : /^[A-Za-z]:$/.test(cut) ? `${cut}\\` : cut;
    if (!up || up === cur || out.length > 64) return out;
    cur = up;
  }
}

/** Whether `child` is `parent` or inside it. Either slash; without case where the disk ignores it. */
export function isInside(child: string, parent: string, caseless: boolean): boolean {
  // Either slash, no slash at the end; the root itself ('/') and a drive ('C:') end without one too.
  const norm = (p: string) => {
    const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return caseless ? s.toLowerCase() : s;
  };
  const c = norm(child);
  const f = norm(parent);
  return c === f || c.startsWith(`${f}/`);
}
export const sharedDir = (root: string, folder: string) => join(root, 'mod', folderKey(folder));
export const imagesDir = (root: string) => join(root, 'mod', 'images');

/**
 * The checklist ids in a shared folder listing: every `<id>.json`, and every `<id>.json.bak` without one
 * (a first save cut short after the backup). Not the `.moved` ones.
 */
export function listIds(names: string[]): string[] {
  const ids = names.map((n) => /^([A-Za-z0-9-]+)\.json(?:\.bak)?$/.exec(n)?.[1]).filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/**
 * A screenshot path as the user typed it, made absolute: `~/…` is under `home`, a relative path is
 * under `cwd`. Quotes around it (from a drag and drop) are dropped.
 */
export function absolutePath(typed: string, home: string, cwd: string): string {
  const p = typed.trim().replace(/^["']|["']$/g, '');
  if (/^~(?=$|[\\/])/.test(p)) return join(home, p.slice(1));
  if (/^([\\/]|[A-Za-z]:[\\/])/.test(p)) return p;
  return join(cwd, p.replace(/^\.[\\/]/, ''));
}

/** A VS Code window as it announces itself in `<root>/windows/` (written by the extension, see registry.ts). */
export interface WindowInfo {
  windowId: string;
  port: number;
  token: string;
  pid: number;
  folders: string[];
  focusedAt: number;
  name: string;
}

/** A window file's contents, or undefined if it isn't one (half-written, or something else). */
export function parseWindow(text: string | undefined): WindowInfo | undefined {
  try {
    const w = JSON.parse(text ?? '');
    if (!w || !Number.isInteger(w.port) || typeof w.token !== 'string') return undefined;
    const folders = Array.isArray(w.folders) ? w.folders.map(String) : [];
    return { windowId: String(w.windowId), port: w.port, token: w.token, pid: Number(w.pid) || 0, folders, focusedAt: Number(w.focusedAt) || 0, name: String(w.name ?? '') };
  } catch {
    return undefined;
  }
}

/** What tells a chat which VS Code window is its own, most reliable first (see rankWindows). */
export interface WindowHints {
  /** The window id the extension put in the environment of the terminal the chat was started from. */
  envWindow?: string;
  /** The process of the VS Code window Claude Code's own VS Code integration is connected to. */
  idePid?: number;
  /** The chat's folder. */
  cwd: string;
  /** Whether paths ignore case (Windows and macOS disks do). */
  caseless: boolean;
}

/**
 * The windows best first, with why each one is picked: the one the chat was started from, the one Claude
 * Code's VS Code integration is connected to, those with the chat's folder open (the deepest folder first,
 * then the one used last), then the rest, the one used last first. The connector and the mod both use this.
 */
export function rankWindows(wins: WindowInfo[], hints: WindowHints): { w: WindowInfo; why: string; rank: string }[] {
  const here = hints.cwd;
  const scored = wins.map((w) => {
    const depth = Math.max(-1, ...w.folders.filter((f) => f.trim() && isInside(here, f, hints.caseless)).map((f) => f.trim().length));
    const first = hints.envWindow && w.windowId === hints.envWindow ? 2 : hints.idePid !== undefined && w.pid === hints.idePid ? 1 : 0;
    const why =
      first === 2 ? 'started from this window' : first === 1 ? 'Claude Code is connected to this window' : depth >= 0 ? 'this window has the project open' : 'most recently used window';
    return { w, why, first, depth };
  });
  scored.sort((a, b) => b.first - a.first || b.depth - a.depth || b.w.focusedAt - a.w.focusedAt);
  // `rank` is the same for windows only the time of use tells apart.
  return scored.map(({ w, why, first, depth }) => ({ w, why, rank: `${first}:${depth}` }));
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
