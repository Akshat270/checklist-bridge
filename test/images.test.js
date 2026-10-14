// Screenshots are stored as separate files: format, loading, cleanup, upgrading old checklists,
// and the full path through the real extension (panel -> disk -> reload -> Claude).
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const { ImageFiles } = require(ROOT + '/dist/images.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const listWith = (id, imgs) => ({ id, title: 'Shots', tasks: [{ id: 't1', text: 'x', tags: [], draft: { done: true, note: '', images: imgs }, shared: { at: 1, done: true, note: '', images: [...imgs] } }], questions: [] });

(async () => {
  // ---- unit: ImageFiles
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbi-'));
    const im = new ImageFiles(dir);
    const big = { id: 'a1b2c3d4', mime: 'image/png', data: b64(1_000_000), w: 800, h: 600 };
    const c = listWith('L1', [big]);
    const json = im.serialize(c);
    check(!json.includes(big.data) && json.length < 2000, `saved JSON holds no screenshot data (${json.length} bytes for a 1 MB screenshot)`);
    const f = im.file('L1', big);
    check(fs.existsSync(f) && fs.readFileSync(f).equals(Buffer.from(big.data, 'base64')), 'the screenshot is a real image file with the same bytes');
    const mtime = fs.statSync(f).mtimeMs; await sleep(20); im.serialize(c);
    check(fs.statSync(f).mtimeMs === mtime, 'a screenshot file is written once, not on every save');

    const back = JSON.parse(json); new ImageFiles(dir).hydrate(back);
    check(back.tasks[0].draft.images[0].data === big.data && back.tasks[0].shared.images[0].data === big.data, 'loading puts the screenshot data back');

    const lost = JSON.parse(json); fs.renameSync(f, f + '.moved');
    new ImageFiles(dir).hydrate(lost);
    check(lost.tasks[0].draft.images.length === 0, 'a screenshot whose file is missing is dropped instead of breaking the checklist');
    fs.renameSync(f + '.moved', f);

    fs.writeFileSync(path.join(dir, 'L9-deadbeef.png'), 'old');
    new ImageFiles(dir).cleanup([back]);
    check(fs.existsSync(f) && !fs.existsSync(path.join(dir, 'L9-deadbeef.png')), 'unused screenshot files are cleaned up, used ones kept');

    const evil = im.file('../../etc', { id: '../passwd', mime: 'image/png' });
    check(path.dirname(evil) === dir, 'file names cannot escape the screenshots folder');
  }

  // ---- end to end through the real extension
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbie-')); process.env.CHECKLIST_BRIDGE_HOME = HOME;
  const ST = path.join(HOME, 'st'), CL = path.join(ST, 'checklists');
  const win = () => {
    const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['unilytic', '/work/unilytic', ROOT, ST, '1']);
    const waiters = []; W.on('message', (m) => { if (m.windowId) W.id = m.windowId; const i = waiters.findIndex((x) => x.k in m); if (i >= 0) waiters.splice(i, 1)[0].r(m); });
    W.wait = (k) => new Promise((r) => waiters.push({ k, r }));
    W.exited = new Promise((r) => W.on('exit', r));
    W.state = async () => { W.send({ cmd: 'panels' }); await W.wait('panels'); };
    return W;
  };
  const chat = (id) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'harness', 'fakeclaude.js'), path.join(HOME, 'connector', 'connector.js')], { env: { ...process.env, CHECKLIST_BRIDGE_SESSION: 'img', CHECKLIST_BRIDGE_WINDOW: id }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', n = 0; const wait = {};
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (wait[m.id]) wait[m.id](m); } });
    const rpc = (method, params) => new Promise((r) => { const k = ++n; wait[k] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
    return { rpc, tool: async (name, args) => (await rpc('tools/call', { name, arguments: args })).result, kill: () => p.kill() };
  };

  // Old-format checklist from an earlier version, with an inline screenshot.
  fs.mkdirSync(CL, { recursive: true });
  const oldShot = b64(50_000);
  const old = listWith('oldlist', [{ id: 'cafe0001', mime: 'image/jpeg', data: oldShot, w: 10, h: 10 }]);
  Object.assign(old, { sessionId: 'legacy', createdAt: 1, updatedAt: 1, groupOrder: [], nextQ: 1 });
  fs.writeFileSync(path.join(CL, 'oldlist.json'), JSON.stringify(old));

  let W = win(); await W.wait('ready');
  await sleep(800);
  const converted = fs.readFileSync(path.join(CL, 'oldlist.json'), 'utf8');
  check(!converted.includes(oldShot) && fs.existsSync(path.join(CL, 'images', 'oldlist-cafe0001.jpg')), 'a checklist saved by an older version is converted: screenshot moved to its own file');

  const C = chat(W.id);
  await C.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  await C.tool('checklist_add_tasks', { title: 'Shots', tasks: ['Check the dashboard'] });
  const shot = b64(2_000_000);
  W.send({ cmd: 'user', title: 'Shots', msg: { type: 'addImages', taskId: 't1', images: [{ mime: 'image/png', data: shot, w: 1200, h: 800 }] } }); await W.wait('done');
  W.send({ cmd: 'user', title: 'Shots', msg: { type: 'share', taskId: 't1', note: 'see screenshot', done: true } }); await W.wait('done');
  await sleep(700);
  const files = fs.readdirSync(CL).filter((f) => f.endsWith('.json') && f !== 'oldlist.json');
  const saved = fs.readFileSync(path.join(CL, files[0]), 'utf8');
  check(saved.length < 5000, `the saved checklist stays small with a 2 MB screenshot (${saved.length} bytes)`);

  W.send({ cmd: 'panels' }); const ps = (await W.wait('panels')).panels;
  const lastState = await new Promise((r) => { W.on('message', (m) => m.state && r(m.state)); W.send({ cmd: 'user', title: 'Shots', msg: { type: 'ready' } }); });
  const img = lastState.list.tasks[0].shared.images[0];
  check(img && !img.data && /images/.test(img.src), 'the panel loads the screenshot from its file instead of receiving the data');

  W.send({ cmd: 'quit' }); await W.exited;
  W = win(); await W.wait('ready'); await sleep(300);
  const r = await C.tool('checklist_read', { include_earlier_images: true });
  const sent = r.content.filter((x) => x.type === 'image');
  check(sent.some((x) => x.data === shot) && sent.length >= 1, 'after a restart Claude still receives the exact screenshot');

  C.kill(); W.send({ cmd: 'quit' }); await W.exited;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
