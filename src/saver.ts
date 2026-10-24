// Saves checklists to disk. No `vscode` import, so it can be tested on its own.
//
// - Saves soon after the first change, not after the last one (a busy panel would keep pushing that back).
// - Writes in the background, so a checklist full of screenshots doesn't freeze VS Code.
// - Writes to a temp file and renames it over the real one, so a crash mid-write can't leave a broken file.
// - On Windows, antivirus or the search indexer can briefly lock the file: the rename is retried,
//   then the file is written directly, and if even that fails the change stays queued and is tried again.
// - close() writes everything still pending, for when the window shuts down.
import * as fs from 'fs';
import * as path from 'path';

const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let tmpSeq = 0;

/**
 * Writes a file the way Saver does, at once: to a temp file renamed over the real one, retrying while
 * Windows has it locked and writing it in place if it stays locked. For files outside Saver's folder
 * (the checklists handed to the Claude Code mod).
 */
export function writeFileSafe(target: string, text: string | Buffer) {
  const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, target);
        return;
      } catch (e: any) {
        if (!LOCKED.has(e?.code)) throw e;
        if (attempt >= 3) {
          fs.writeFileSync(target, text);
          return;
        }
        sleepSync(40);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export class Saver {
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  /** Bumped on every change; a write only lands if nothing newer has been written since. */
  private version = new Map<string, number>();
  private written = new Map<string, number>();
  /** Per checklist: failed attempts in a row, and when to try again. One locked file doesn't slow the others. */
  private failures = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private stopped = false;

  constructor(
    private dir: string,
    private serialize: (id: string) => string | undefined,
    private log: (s: string) => void = () => {},
    private delayMs = 300
  ) {
    fs.mkdirSync(dir, { recursive: true });
    // Temp files left by a crash (not recent ones: another window sharing this folder may be mid-save).
    const old = Date.now() - 60_000;
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.tmp')) continue;
      const f = path.join(dir, n);
      try {
        if (fs.statSync(f).mtimeMs < old) fs.rmSync(f, { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  /** Something in this checklist changed. */
  mark(id: string) {
    if (this.stopped) return;
    this.dirty.add(id);
    this.version.set(id, (this.version.get(id) ?? 0) + 1);
    this.kick(this.delayMs);
  }

  /** The checklist was deleted: stop saving it and remove its file. */
  remove(id: string) {
    this.dirty.delete(id);
    this.failures.delete(id);
    this.retryAt.delete(id);
    this.version.set(id, (this.version.get(id) ?? 0) + 1);
    this.written.set(id, Infinity); // nothing in flight may recreate it
    fs.promises.rm(this.file(id), { force: true }).catch(() => {});
  }

  /**
   * Saves everything pending now (skipping the wait and any retry delay) and resolves when done, or
   * after a few passes if something keeps failing. For tests and diagnostics.
   */
  async idle() {
    for (let pass = 0; pass < 5; pass++) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      while (this.running) await this.running; // a pass started earlier may still be finishing
      if (!this.dirty.size || this.stopped) return;
      this.retryAt.clear();
      this.pump();
      while (this.running) await this.running;
      if (!this.dirty.size) return;
    }
  }

  /**
   * The window is closing: write everything pending right now, synchronously, and stop.
   * After this the saver ignores further changes, so only call it on shutdown.
   */
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of [...this.dirty]) {
      this.dirty.delete(id);
      const v = this.version.get(id) ?? 0;
      const text = this.serialize(id);
      if (text === undefined) continue;
      try {
        this.writeSync(id, text);
        this.written.set(id, v);
      } catch (e) {
        this.log(`Could not save checklist ${id} while closing: ${e}`);
      }
    }
    this.stopped = true; // background writes still in flight must not overwrite what we just wrote
  }

  private kick(ms: number) {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, Math.max(0, ms));
  }

  /** Start a save pass unless one is running (that one re-kicks when it finishes). */
  private pump() {
    if (this.running || this.stopped) return;
    // .finally() always runs after this assignment, even when the pass has nothing to await.
    this.running = this.run().finally(() => {
      this.running = undefined;
      const next = this.nextDelay();
      if (next !== undefined) this.kick(next);
    });
  }

  private nextDelay(): number | undefined {
    if (!this.dirty.size || this.stopped) return undefined;
    const now = Date.now();
    let soonest = Infinity;
    for (const id of this.dirty) soonest = Math.min(soonest, (this.retryAt.get(id) ?? now + this.delayMs) - now);
    return soonest;
  }

  private async run() {
    for (const id of [...this.dirty]) {
      if (this.stopped) return;
      if ((this.retryAt.get(id) ?? 0) > Date.now()) continue; // backing off after failures
      this.dirty.delete(id);
      const v = this.version.get(id) ?? 0;
      const text = this.serialize(id);
      if (text === undefined) continue;
      try {
        await this.write(id, text, v);
        if (this.failures.has(id)) this.log(`Saving checklist ${id} works again.`);
        this.failures.delete(id);
        this.retryAt.delete(id);
      } catch (e) {
        // Keep it queued and try again, backing off up to 10 s.
        const n = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, n);
        this.retryAt.set(id, Date.now() + Math.min(10_000, 250 * 2 ** n));
        if (n === 1 || n % 20 === 0) this.log(`Saving checklist ${id} failed, will retry: ${e}`);
        this.dirty.add(id);
      }
    }
  }

  private newer(id: string, v: number) {
    return this.stopped || (this.written.get(id) ?? -1) >= v;
  }

  private async write(id: string, text: string, v: number) {
    const target = this.file(id);
    const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
    await fs.promises.writeFile(tmp, text);
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.newer(id, v)) return; // something newer is already on disk
        try {
          await fs.promises.rename(tmp, target);
          this.written.set(id, v);
          return;
        } catch (e: any) {
          if (!LOCKED.has(e?.code) || attempt >= 4) {
            if (!LOCKED.has(e?.code)) throw e;
            // Still locked: write the file in place instead.
            if (this.newer(id, v)) return;
            await fs.promises.writeFile(target, text);
            this.written.set(id, v);
            return;
          }
          await sleep(50 * 2 ** attempt);
        }
      }
    } finally {
      fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }

  private writeSync(id: string, text: string) {
    writeFileSafe(this.file(id), text);
  }
}
