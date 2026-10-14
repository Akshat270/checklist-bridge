// VS Code windows with no folder open share one storage folder. Each checklist must stay in the
// window that owns it, never be overwritten by another window's copy, and move to another window
// once its own window closes, reloads or crashes.
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-')); process.env.CHECKLIST_BRIDGE_HOME = HOME;
const ST = path.join(HOME, 'global'), CL = path.join(ST, 'checklists');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

function win(name) {
  const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), [name, '/work/' + name, ROOT, ST, '1']);
  const waiters = [];
  W.on('message', (m) => { if (m.windowId) W.id = m.windowId; const i = waiters.findIndex((x) => x.k in m); if (i >= 0) waiters.splice(i, 1)[0].r(m); });
  W.wait = (k) => new Promise((r) => waiters.push({ k, r }));
  W.exited = new Promise((r) => W.on('exit', r));
  W.titles = async () => (W.send({ cmd: 'panels' }), (await W.wait('panels')).panels.map((p) => p.title));
  W.user = async (title, msg) => (W.send({ cmd: 'user', title, msg }), W.wait('done'));
  return W;
}
async function addTasks(W, title) {
  const p = spawn(process.execPath, [path.join(__dirname, 'harness', 'fakeclaude.js'), path.join(HOME, 'connector', 'connector.js')], { env: { ...process.env, CHECKLIST_BRIDGE_SESSION: title, CHECKLIST_BRIDGE_WINDOW: W.id }, stdio: ['pipe', 'pipe', 'pipe'] });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'checklist_add_tasks', arguments: { title, tasks: ['One', 'Two'] } } });
  await new Promise((r) => { let b = ''; p.stdout.on('data', (d) => { b += d; if (b.includes('"id":2')) r(); }); });
  p.kill();
}
const disk = (title) => {
  for (const f of fs.readdirSync(CL).filter((n) => n.endsWith('.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(CL, f), 'utf8'));
    if (c.title === title) return c;
  }
};

(async () => {
  const A = win('A'); await A.wait('ready');
  await addTasks(A, 'From A'); await sleep(600);
  const B = win('B'); await B.wait('ready'); await sleep(1800);
  await addTasks(B, 'From B'); await sleep(600);

  check(!(await B.titles()).includes('From A'), "a second folderless window doesn't show the first window's checklist");
  check(!(await A.titles()).includes('From B'), 'and the first window does not show the second one\'s');

  await A.user('From A', { type: 'draft', taskId: 't1', done: true, note: 'ticked in A' }); await sleep(600);
  await B.user('From B', { type: 'draft', taskId: 't1', done: true }); await sleep(600);
  const a = disk('From A');
  check(a && a.tasks[0].draft.done && a.tasks[0].draft.note === 'ticked in A', "work in one window isn't overwritten by the other");

  // A reloads: it gets its own checklist back, B keeps its own.
  A.send({ cmd: 'shutdown' }); await A.exited;
  const A2 = win('A'); await A2.wait('ready'); await sleep(1800);
  const t2 = await A2.titles();
  check(t2.includes('From A') && !t2.includes('From B'), 'after a reload, a window gets its own checklists back (and not the other window\'s)');

  // B is closed for good: its checklist moves to the next window that starts.
  B.send({ cmd: 'shutdown' }); await B.exited;
  const C = win('C'); await C.wait('ready'); await sleep(1800);
  check((await C.titles()).includes('From B'), "a closed window's checklists are picked up by the next window");

  // A crashes (no clean shutdown): its claim dies with it.
  A2.kill('SIGKILL'); await A2.exited;
  const D = win('D'); await D.wait('ready'); await sleep(1800);
  const d = await D.titles();
  check(d.includes('From A') && !d.includes('From B'), "a crashed window's checklists are picked up too, and C keeps its own");
  const reloaded = disk('From A');
  check(reloaded.tasks[0].draft.note === 'ticked in A', 'nothing was lost along the way');

  C.send({ cmd: 'quit' }); D.send({ cmd: 'quit' }); await Promise.all([C.exited, D.exited]);
  check(!fs.readdirSync(CL).some((n) => n.endsWith('.owner')), 'closed windows hand back their checklists');
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
