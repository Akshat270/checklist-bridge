// Saving checklists: timing, locked files (as on Windows), retries, and shutdown ordering.
const path = require('path'), fs = require('fs'), os = require('os');
const { Saver } = require(path.resolve(__dirname, '..', 'dist', 'saver.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-'));
const read = (d, id) => { try { return fs.readFileSync(path.join(d, id + '.json'), 'utf8'); } catch { return undefined; } };
const P = fs.promises;
const orig = { rename: P.rename, writeFile: P.writeFile, renameSync: fs.renameSync };
const restore = () => Object.assign(P, { rename: orig.rename, writeFile: orig.writeFile }) && (fs.renameSync = orig.renameSync);
const locked = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted`), { code });

(async () => {
  // 1. Saves soon after the first change, even while changes keep coming.
  {
    const d = dir(); let n = 0; const data = { a: 0 };
    const s = new Saver(d, () => JSON.stringify(data), () => {}, 300);
    const t0 = Date.now(); let firstWrite;
    const watch = setInterval(() => { if (!firstWrite && read(d, 'a')) firstWrite = Date.now() - t0; }, 10);
    for (let i = 0; i < 12; i++) { data.a = ++n; s.mark('a'); await sleep(100); }
    await s.idle(); clearInterval(watch);
    check(firstWrite !== undefined && firstWrite < 600, `first save lands while edits continue (${firstWrite} ms)`);
    check(JSON.parse(read(d, 'a')).a === 12, 'the latest change is what ends up on disk');
    check(!fs.readdirSync(d).some((f) => f.endsWith('.tmp')), 'no temp files left');
  }

  // 2. Windows: antivirus holds the file for a moment; the rename is retried.
  {
    const d = dir(); let fails = 2;
    P.rename = async (...a) => { if (fails-- > 0) throw locked('EPERM'); return orig.rename(...a); };
    const s = new Saver(d, () => '{"v":1}');
    s.mark('a'); await s.idle(); restore();
    check(read(d, 'a') === '{"v":1}', 'a briefly locked file is saved after retrying');
  }

  // 3. The file stays locked: it's written in place instead.
  {
    const d = dir(); fs.writeFileSync(path.join(d, 'a.json'), '{"v":0}');
    P.rename = async () => { throw locked('EBUSY'); };
    const s = new Saver(d, () => '{"v":2}');
    s.mark('a'); await s.idle(); restore();
    check(read(d, 'a') === '{"v":2}', 'a file that stays locked is written directly');
  }

  // 4. Saving fails outright for a while: the change is kept and saved once it works again.
  {
    const d = dir(); let broken = true; const logs = [];
    P.writeFile = async (...a) => { if (broken) throw locked('EACCES'); return orig.writeFile(...a); };
    const s = new Saver(d, () => '{"v":3}', (m) => logs.push(m), 50);
    s.mark('a'); await sleep(700);
    check(read(d, 'a') === undefined && logs.some((l) => /will retry/.test(l)), 'a failed save is reported and kept');
    broken = false; restore();
    await sleep(2500); await s.idle();
    check(read(d, 'a') === '{"v":3}', 'it is saved once saving works again');
    check(logs.some((l) => /works again/.test(l)), 'and says so in the log');
  }

  // 5. Shutdown while a slow background save is in flight: the newer content must win.
  {
    const d = dir(); const data = { v: 'old' };
    P.writeFile = async (...a) => { await sleep(300); return orig.writeFile(...a); };
    const s = new Saver(d, () => JSON.stringify(data), () => {}, 0);
    s.mark('a'); await sleep(50); // background write of "old" is now in flight
    data.v = 'new'; s.mark('a'); s.close(); // window closes
    await sleep(700); restore();
    check(JSON.parse(read(d, 'a')).v === 'new', 'a slow background save cannot overwrite what was saved on shutdown');
  }

  // 6. Shutdown with a locked file: the synchronous save retries, then writes in place.
  {
    const d = dir(); let fails = 10;
    fs.renameSync = (...a) => { if (fails-- > 0) throw locked('EPERM'); return orig.renameSync(...a); };
    const s = new Saver(d, () => '{"v":"closing"}', () => {}, 10_000);
    s.mark('a'); s.close(); restore();
    check(read(d, 'a') === '{"v":"closing"}', 'saving on shutdown works even if the file is locked');
  }

  // 7. Deleted checklists stay deleted, and temp files from a crash are cleaned up.
  {
    const d = dir(); fs.writeFileSync(path.join(d, 'x.json.123.4.tmp'), 'junk');
    P.writeFile = async (...a) => { await sleep(200); return orig.writeFile(...a); };
    const s = new Saver(d, () => '{"v":1}', () => {}, 0);
    check(!fs.existsSync(path.join(d, 'x.json.123.4.tmp')), 'leftover temp files are removed on start');
    s.mark('a'); await sleep(50); s.remove('a'); await sleep(500); restore();
    check(read(d, 'a') === undefined, 'a save in flight does not bring back a deleted checklist');
  }

  // 8. The disk write itself happens in the background (serializing still runs on the main thread).
  {
    const d = dir(); const big = JSON.stringify({ img: 'x'.repeat(30_000_000) });
    const s = new Saver(d, () => big, () => {}, 0);
    let maxGap = 0, last = Date.now();
    const tick = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
    s.mark('a'); await s.idle(); clearInterval(tick);
    check(read(d, 'a').length === big.length, `writing 30 MB to disk happens in the background (longest pause ${maxGap} ms)`);
  }

  // 9. A save pass with nothing to write (its checklist was deleted) must not stall later saves.
  {
    const d = dir(); const data = {};
    const s = new Saver(d, (id) => data[id], () => {}, 50);
    let timers = 0; const st = global.setTimeout; global.setTimeout = (...a) => (timers++, st(...a));
    s.mark('gone'); await sleep(150); // its pass finds nothing to write
    data.b = '{"b":1}'; s.mark('b'); await sleep(300);
    global.setTimeout = st;
    check(read(d, 'b') === '{"b":1}', 'saving keeps working after a pass with nothing to write');
    check(timers < 40, `no runaway timers (${timers} scheduled)`);
    const done = await Promise.race([s.idle().then(() => true), sleep(1000).then(() => false)]);
    check(done, 'idle() resolves');
  }

  // 10. One checklist's file stays locked: the others keep saving at normal speed.
  {
    const d = dir(); let n = 0;
    const isLocked = (p) => String(p).includes('stuck');
    P.writeFile = async (p, ...a) => { if (isLocked(p)) throw locked('EACCES'); return orig.writeFile(p, ...a); };
    const s = new Saver(d, (id) => JSON.stringify({ id, n }), () => {}, 100);
    s.mark('stuck'); await sleep(1500); // stuck is now backing off for a while
    n = 7; const t0 = Date.now(); s.mark('fine');
    while (!read(d, 'fine') && Date.now() - t0 < 3000) await sleep(20);
    restore();
    check(read(d, 'fine') && Date.now() - t0 < 600, `a locked checklist doesn't slow down saving the others (${Date.now() - t0} ms)`);
    await s.idle();
    check(read(d, 'stuck') !== undefined, 'the locked one is saved once it unlocks');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
