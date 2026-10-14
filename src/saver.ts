// Saves checklists to disk. No `vscode` import, so it can be tested on its own.
//
// - Saves soon after the first change, not after the last one (a busy panel would keep pushing that back).
// - Writes in the background, so a checklist full of screenshots doesn't freeze VS Code.
// - Writes to a temp file and renames it over the real one, so a crash mid-write can't leave a broken file.
// - On Windows, antivirus or the search indexer can briefly lock the file: the rename is retried,
//   then the file is written directly, and if even that fails the change stays queued and is tried again.
// - flushSync() writes everything still pending, for when the window shuts down.
import * as fs from 'fs';
import * as path from 'path';

const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Saver {
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  /** Bumped on every change; a write only lands if nothing newer has been written since. */
  private version = new Map<string, number>();
  private written = new Map<string, number>();
  private failures = 0;
  private tmpSeq = 0;
  private stopped = false;

  constructor(
    private dir: string,
    private serialize: (id: string) => string | undefined,
    private log: (s: string) => void = () => {},
    private delayMs = 300
  ) {
    fs.mkdirSync(dir, { recursive: true });
    // Temp files left by a crash.
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.tmp')) fs.rmSync(path.join(dir, n), { force: true });
  }

  file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  /** Something in this checklist changed. */
  mark(id: string) {
    if (this.stopped) return;
    this.dirty.add(id);
    this.version.set(id, (this.version.get(id) ?? 0) + 1);
    this.schedule(this.delayMs);
  }

  /** The checklist was deleted: stop saving it and remove its file. */
  remove(id: string) {
    this.dirty.delete(id);
    this.version.set(id, (this.version.get(id) ?? 0) + 1);
    this.written.set(id, Infinity); // nothing in flight may recreate it
    fs.promises.rm(this.file(id), { force: true }).catch(() => {});
  }

  /** Resolves once everything changed so far is on disk (or has failed for now). */
  async idle() {
    while (this.running || (this.timer && this.dirty.size)) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.running ??= this.run();
      }
      await this.running;
    }
  }

  /** Write everything pending right now, synchronously. Used when the window shuts down. */
  flushSync() {
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

  private schedule(ms: number) {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.running) {
        // A write is in progress; go again when it's done.
        this.running.then(() => this.dirty.size && this.schedule(0));
        return;
      }
      this.running = this.run();
    }, ms);
  }

  private async run() {
    try {
      for (const id of [...this.dirty]) {
        if (this.stopped) return;
        this.dirty.delete(id);
        const v = this.version.get(id) ?? 0;
        const text = this.serialize(id);
        if (text === undefined) continue;
        try {
          await this.write(id, text, v);
          if (this.failures) this.log('Saving works again.');
          this.failures = 0;
        } catch (e) {
          // Keep it queued and try again, backing off up to 10 s.
          this.failures++;
          if (this.failures === 1 || this.failures % 20 === 0) this.log(`Save failed, will retry: ${e}`);
          this.dirty.add(id);
        }
      }
    } finally {
      this.running = undefined;
      if (this.dirty.size && !this.stopped) this.schedule(this.failures ? Math.min(10_000, 250 * 2 ** this.failures) : this.delayMs);
    }
  }

  private newer(id: string, v: number) {
    return this.stopped || (this.written.get(id) ?? -1) >= v;
  }

  private async write(id: string, text: string, v: number) {
    const target = this.file(id);
    const tmp = `${target}.${process.pid}.${++this.tmpSeq}.tmp`;
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
    const target = this.file(id);
    const tmp = `${target}.${process.pid}.${++this.tmpSeq}.tmp`;
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
}
