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

interface OwnerRecord { pid: number; token: string }

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
  readonly token = randomUUID();

  constructor(private dir: string, private pid = process.pid) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string) {
    return path.join(this.dir, `${id.replace(/[^\w-]/g, '_')}.owner`);
  }

  owns(id: string) {
    return this.owned.has(id);
  }

  /** Take a checklist if no other live window has it. Returns true if this window now owns it. */
  claim(id: string): boolean {
    if (this.owned.has(id)) return true;
    const f = this.file(id);
    const mine = JSON.stringify({ pid: this.pid, token: this.token } satisfies OwnerRecord);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(f, mine, { flag: 'wx' }); // only succeeds if nobody owns it
        this.owned.add(id);
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
      if (rec?.token === this.token) {
        this.owned.add(id);
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
