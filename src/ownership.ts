// Which VS Code window a checklist belongs to. No `vscode` import, so it can be tested on its own.
//
// Windows without a folder open all share one storage folder, so without this two such windows
// would both load every checklist there, show each other's, and overwrite each other's changes.
// Each checklist file gets a small `<id>.owner` file naming the window (extension host) that has it.
// A window only loads and saves checklists it owns. An owner file is honoured while its process is
// alive and the file was written since the computer last started (so a reused process id after a
// reboot doesn't count, and a laptop waking from sleep keeps its claims). After a reload, crash or
// close, the next window to start takes the checklist over.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

interface OwnerRecord { pid: number; token: string; window?: string }

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export class Ownership {
  private owned = new Set<string>();
  // Claims by other windows we have noticed, and which window each came from. An entry goes once the
  // checklist is ours, or its claim file has been gone for a minute with nothing to take.
  private seen = new Map<string, { window?: string; at: number }>();
  readonly token = randomUUID();

  constructor(private dir: string, private pid = process.pid, private windowId?: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string) {
    return path.join(this.dir, `${id.replace(/[^\w-]/g, '_')}.owner`);
  }

  owns(id: string) {
    return this.owned.has(id);
  }

  /**
   * Note who holds each claim right now, so that we still know afterwards who it was even if the
   * holder hands it back before its checklist file shows up (a window saves and lets go as it closes).
   */
  observe() {
    const now = Date.now();
    const present = new Set<string>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.owner'));
    } catch {
      /* nothing to look at */
    }
    for (const n of names) {
      const id = n.slice(0, -'.owner'.length);
      if (this.owned.has(id)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')) as OwnerRecord;
        if (rec.token === this.token) continue;
        present.add(id);
        this.seen.set(id, { window: rec.window, at: now });
      } catch {
        /* just removed or unreadable: nothing to note */
      }
    }
    for (const [id, e] of this.seen) if (this.owned.has(id) || (!present.has(id) && now - e.at > 60_000)) this.seen.delete(id);
  }

  /** How many checklists held by other windows we are keeping an eye on. */
  waitingOn() {
    return this.seen.size;
  }

  /**
   * Take a checklist if no other live window has it. Returns true if this window now owns it.
   * With `onlyFromMyWindow`, a checklist last held by a different window is left alone even if that
   * window is gone: used when looking again after startup, to catch up with an earlier copy of this
   * window (a reload) without taking over what a closing neighbour leaves behind.
   */
  claim(id: string, onlyFromMyWindow = false): boolean {
    if (this.owned.has(id)) return true;
    const f = this.file(id);
    if (onlyFromMyWindow) {
      try {
        this.seen.set(id, { window: (JSON.parse(fs.readFileSync(f, 'utf8')) as OwnerRecord).window, at: Date.now() });
      } catch {
        /* handed back or unreadable: go by what we saw before */
      }
      const e = this.seen.get(id); // the file is gone once its window handed it back
      const last = e?.window;
      // Claims written by 0.5.0 name no window. For a folder window (stable id) that is still ours to
      // take, so the first reload after an update works too. A folder window's storage belongs to its
      // workspace alone, so nobody else can have held it. A folderless window never matches.
      const oldClaim = !!e && last === undefined;
      if (!this.windowId || (last !== this.windowId && !(oldClaim && this.windowId.startsWith('ws-')))) return false;
    }
    const mine = JSON.stringify({ pid: this.pid, token: this.token, window: this.windowId } satisfies OwnerRecord);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(f, mine, { flag: 'wx' }); // only succeeds if nobody owns it
        this.owned.add(id);
        this.seen.delete(id);
        return true;
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e;
      }
      // Someone has (or had) it. Take over only if that window is gone.
      let rec: OwnerRecord | undefined;
      let mtime = 0;
      try {
        rec = JSON.parse(fs.readFileSync(f, 'utf8'));
        mtime = fs.statSync(f).mtimeMs;
      } catch {
        /* unreadable or just removed: treat as stale */
      }
      if (rec) this.seen.set(id, { window: rec.window, at: Date.now() });
      if (rec?.token === this.token) {
        this.owned.add(id);
        this.seen.delete(id);
        return true;
      }
      const bootedAt = Date.now() - os.uptime() * 1000 - 60_000;
      const fresh = rec && mtime > bootedAt && alive(rec.pid);
      if (fresh) return false;
      fs.rmSync(f, { force: true }); // stale: remove and race for it once more
    }
    return false;
  }

  /** Stop owning a checklist (deleted, or the window is closing). */
  release(id: string) {
    if (!this.owned.delete(id)) return;
    try {
      const rec: OwnerRecord = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      if (rec.token === this.token) fs.rmSync(this.file(id), { force: true });
    } catch {
      /* already gone */
    }
  }

  /** The window is closing: hand everything back so the next window can take it straight away. */
  releaseAll() {
    for (const id of [...this.owned]) this.release(id);
  }
}
