// Where VS Code windows announce themselves so each Claude chat can find its own window.
// Shared by the extension (writes) and the per-chat connector (reads). No `vscode` import.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface WindowInfo {
  windowId: string;
  port: number;
  token: string;
  pid: number;
  folders: string[];
  focusedAt: number;
  name: string;
}

export const ROOT = process.env.CHECKLIST_BRIDGE_HOME || path.join(os.homedir(), '.checklist-bridge');
export const WINDOWS_DIR = path.join(ROOT, 'windows');
export const ENV_WINDOW = 'CHECKLIST_BRIDGE_WINDOW';

const file = (id: string) => path.join(WINDOWS_DIR, `${id.replace(/[^\w-]/g, '_')}.json`);

export function writeWindow(info: WindowInfo) {
  fs.mkdirSync(WINDOWS_DIR, { recursive: true });
  const tmp = file(info.windowId) + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, file(info.windowId));
}

export function removeWindow(id: string, pid: number) {
  try {
    const cur = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    if (cur.pid === pid) fs.unlinkSync(file(id));
  } catch {
    /* already gone */
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function readWindows(): WindowInfo[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(WINDOWS_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: WindowInfo[] = [];
  for (const n of names) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(WINDOWS_DIR, n), 'utf8')) as WindowInfo;
      if (w && typeof w.port === 'number' && alive(w.pid)) out.push(w);
    } catch {
      /* half-written or stale file */
    }
  }
  return out;
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

/** The PID of the VS Code extension host that launched this Claude chat, via Claude Code's own IDE lock file. */
function idePid(env: NodeJS.ProcessEnv): number | undefined {
  const port = env.CLAUDE_CODE_SSE_PORT;
  if (!port) return undefined;
  const dirs = [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean) as string[];
  for (const d of dirs) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(d, 'ide', `${port}.lock`), 'utf8'));
      if (typeof lock.pid === 'number') return lock.pid;
    } catch {
      /* not there */
    }
  }
  return undefined;
}

/**
 * Picks the VS Code window this chat belongs to, most reliable signal first:
 * 1. the window id our extension put in the environment the chat was started from,
 * 2. the window Claude Code's own VS Code integration is connected to,
 * 3. the window that has the chat's project folder open,
 * 4. the window used most recently.
 */
export function pickWindow(env: NodeJS.ProcessEnv, cwd: string, exclude: Set<string> = new Set()): { w: WindowInfo; why: string } | undefined {
  const all = readWindows().filter((w) => !exclude.has(w.windowId));
  if (!all.length) return undefined;

  const byEnv = env[ENV_WINDOW] && all.find((w) => w.windowId === env[ENV_WINDOW]);
  if (byEnv) return { w: byEnv, why: 'started from this window' };

  const pid = idePid(env);
  const byIde = pid !== undefined && all.find((w) => w.pid === pid);
  if (byIde) return { w: byIde, why: 'Claude Code is connected to this window' };

  let best: WindowInfo | undefined;
  let bestLen = -1;
  for (const w of all) {
    for (const f of w.folders) {
      if (inside(cwd, f) && (f.length > bestLen || (f.length === bestLen && w.focusedAt > (best?.focusedAt ?? 0)))) {
        best = w;
        bestLen = f.length;
      }
    }
  }
  if (best) return { w: best, why: 'this window has the project open' };

  const recent = all.sort((a, b) => b.focusedAt - a.focusedAt)[0];
  return { w: recent, why: 'most recently used window' };
}
