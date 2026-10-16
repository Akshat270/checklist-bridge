const __ROOT = require('path').resolve(__dirname, '..');
// Checklists must survive a window reload or a VS Code restart, however VS Code shuts the window down.
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const EXT = __ROOT;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbre-')); process.env.CHECKLIST_BRIDGE_HOME = HOME;
const ST = path.join(HOME, 'st'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

function win(env = {}) {
  const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['unilytic', '/work/unilytic', EXT, ST, '1'], { env: { ...process.env, ...env } });
  const waiters = []; W.opened = 0;
  W.on('message', (m) => { if (m.panelOpened) W.opened++; if (m.log && /Save failed/.test(m.log)) console.log('  log:', m.log); if (m.windowId) W.id = m.windowId; const i = waiters.findIndex((x) => x.k in m); if (i >= 0) waiters.splice(i, 1)[0].r(m); });
  W.wait = (k) => new Promise((r) => waiters.push({ k, r }));
  W.panels = async () => (W.send({ cmd: 'panels' }), (await W.wait('panels')).panels);
  W.user = async (msg) => (W.send({ cmd: 'user', title: 'Persist me', msg }), W.wait('done'));
  W.exited = new Promise((r) => W.on('exit', r));
  return W;
}
async function chatAdd(id) {
  const p = spawn(process.execPath, [path.join(__dirname, 'harness', 'fakeclaude.js'), path.join(HOME, 'connector', 'connector.js')], { env: { ...process.env, CHECKLIST_BRIDGE_SESSION: 'r', CHECKLIST_BRIDGE_WINDOW: id }, stdio: ['pipe', 'pipe', 'pipe'] });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'checklist_add_tasks', arguments: { title: 'Persist me', tasks: ['One', 'Two'] } } });
  await new Promise((r) => { let b = ''; p.stdout.on('data', (d) => { b += d; if (b.includes('"id":2')) r(); }); });
  p.kill();
}
const onDisk = () => {
  const d = path.join(ST, 'checklists');
  return (fs.existsSync(d) ? fs.readdirSync(d) : []).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
};

async function scenario(name, { shutdown, restoreTab, hideFirst, typeLate, waitingTab, twoLists }) {
  fs.rmSync(ST, { recursive: true, force: true });
  let W = win(); await W.wait('ready');
  await chatAdd(W.id); await sleep(100);
  if (twoLists) { await chatAdd(W.id); await sleep(100); } // a second chat, same checklist title
  const listId = onDisk()[0]?.id ?? (await W.panels())[0].id;
  if (hideFirst) { await W.user({ type: 'hide' }); await sleep(3500); }
  else await W.user({ type: 'draft', taskId: 't1', done: true });
  if (typeLate) await W.user({ type: 'draft', taskId: 't2', note: 'typed right before reload' });
  if (shutdown === 'vscode') W.send({ cmd: 'shutdown' }); // closes every tab, then deactivates
  else if (shutdown === 'deactivate') W.send({ cmd: 'quit' });
  else if (shutdown === 'kill') { await sleep(500); W.kill('SIGKILL'); }
  await W.exited;

  const c = onDisk()[0];
  W = win(waitingTab ? { TABS: JSON.stringify(['Persist me']) } : {}); await W.wait('ready');
  if (restoreTab && !hideFirst) { W.send({ cmd: 'restoreTab', listId }); await W.wait('done'); }
  await sleep(2000); // past the 1.5 s reopen
  let ps = await W.panels();
  if (waitingTab) {
    W.beforeClick = ps.length;
    const openIds = new Set(ps.map((p) => p.id));
    const waitingId = onDisk().map((c) => c.id).find((id) => !openIds.has(id)) ?? listId;
    W.send({ cmd: 'restoreTab', listId: waitingId }); await W.wait('done'); // the user clicks the waiting tab
    ps = await W.panels();
  }
  W.send({ cmd: 'quit' }); await W.exited;
  return { c, ps, opened: W.opened, beforeClick: W.beforeClick };
}

(async () => {
  let r = await scenario('vscode', { shutdown: 'vscode', restoreTab: true, typeLate: true });
  check(r.c && r.c.tasks[0].draft.done && r.c.tasks[1].draft.note === 'typed right before reload', 'reload: tick and a note typed right before reloading are both saved');
  check(r.ps.length === 1 && r.ps[0].tasks.length === 2, 'reload: the checklist is back on screen with its tasks');
  check(r.opened === 1, `reload: exactly one tab, no duplicate (${r.opened} opened)`);

  r = await scenario('vscode-no-restore', { shutdown: 'vscode', restoreTab: false });
  check(r.c && !r.c.hidden, 'VS Code closing tabs on shutdown does not count as the user hiding them');
  check(r.ps.length === 1, 'restart without VS Code restoring the tab: the extension reopens it');

  r = await scenario('plain', { shutdown: 'deactivate' });
  check(r.ps.length === 1 && r.c.tasks[0].draft.done, 'plain restart: checklist and tick are back');

  r = await scenario('crash', { shutdown: 'kill', typeLate: true });
  check(r.c && r.c.tasks.length === 2 && r.c.tasks[1].draft.note === 'typed right before reload', 'VS Code killed without warning: changes older than half a second are on disk');
  check(r.ps.length === 1, 'and the checklist comes back');

  r = await scenario('hidden', { shutdown: 'vscode', hideFirst: true, restoreTab: true });
  check(r.c && r.c.hidden && r.ps.length === 0, 'a checklist you hid yourself stays hidden after a reload');

  r = await scenario('background-tab', { shutdown: 'vscode', waitingTab: true });
  check(r.beforeClick === 0, 'a checklist whose tab VS Code is still holding is not opened a second time');
  check(r.ps.length === 1 && r.opened === 1, 'clicking that tab brings the checklist back, once');

  r = await scenario('same-title', { shutdown: 'vscode', waitingTab: true, twoLists: true });
  check(r.beforeClick === 1, 'two checklists with the same title, one tab waiting: the other one is reopened');
  check(r.ps.length === 2, 'and clicking the waiting tab brings back the second, without duplicates');

  // The new window starts while the old one is still shutting down and holds the checklist.
  {
    fs.rmSync(ST, { recursive: true, force: true });
    const A = win(); await A.wait('ready');
    await chatAdd(A.id); await sleep(1500); // let it be saved, as it long has been in a real reload
    const B = win(); await B.wait('ready');
    A.send({ cmd: 'quit' }); await A.exited;
    await sleep(3500);
    const ps = await B.panels();
    check(ps.length === 1 && ps[0].tasks.length === 2, 'reload while the old window still holds the checklist: it appears once the old window lets go');
    B.send({ cmd: 'quit' }); await B.exited;
  }

  const leftovers = fs.readdirSync(path.join(ST, 'checklists')).filter((f) => f.includes('.tmp'));
  check(!leftovers.length, 'no temp files left behind');
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
