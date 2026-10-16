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

  // The new window starts while the old one is still shutting down and holds the checklist. This also
  // covers a reload straight after Claude made it, when its file isn't on disk yet at the first look.
  {
    const until = async (fn, ms = 12000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(200); } };
    for (const [label, wait] of [['an established checklist', true], ['one made just before the reload', false]]) {
      fs.rmSync(ST, { recursive: true, force: true });
      const A = win(); await A.wait('ready');
      await chatAdd(A.id);
      if (wait) await until(() => onDisk().length); // saved, as it long has been in a real reload
      const B = win(); await B.wait('ready');
      A.send({ cmd: 'quit' }); await A.exited;
      const ps = await until(async () => { const x = await B.panels(); return x.length ? x : null; }) || [];
      check(ps.length === 1 && ps[0].tasks.length === 2, `reload while the old window still holds ${label}: it appears once the old window lets go`);
      B.send({ cmd: 'quit' }); await B.exited;
    }
  }

  // VS Code is still holding this checklist's tab: taking the checklist back must not open a second one.
  {
    fs.rmSync(ST, { recursive: true, force: true });
    const A = win(); await A.wait('ready');
    await chatAdd(A.id);
    for (let i = 0; i < 60 && !onDisk().length; i++) await sleep(200);
    const listId = onDisk()[0].id;
    const B = win({ TABS: JSON.stringify(['Persist me']) }); await B.wait('ready');
    A.send({ cmd: 'quit' }); await A.exited;
    await sleep(5000);
    check(B.opened === 0 && (await B.panels()).length === 0, 'taking a checklist back leaves a tab VS Code is still holding alone');
    B.send({ cmd: 'restoreTab', listId }); await B.wait('done');
    check((await B.panels()).length === 1 && B.opened === 1, 'and clicking that tab then brings the checklist back, once');
    B.send({ cmd: 'quit' }); await B.exited;
  }

  // A checklist file that can't be read at first (locked for a moment) is picked up once it can.
  {
    fs.rmSync(ST, { recursive: true, force: true });
    let A = win(); await A.wait('ready');
    await chatAdd(A.id);
    const file = () => { const d = path.join(ST, 'checklists'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f))[0]; };
    await (async () => { for (let i = 0; i < 60 && !onDisk().length; i++) await sleep(200); })();
    A.send({ cmd: 'quit' }); await A.exited;
    const f = file(), good = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, '{ not json');
    const B = win(); await B.wait('ready'); await sleep(2500);
    check((await B.panels()).length === 0, 'an unreadable checklist file is skipped, without stopping the window');
    fs.writeFileSync(f, good);
    let ps = [];
    for (let i = 0; i < 60 && !ps.length; i++) { await sleep(200); ps = await B.panels(); }
    check(ps.length === 1, 'and the checklist appears once the file can be read');
    B.send({ cmd: 'quit' }); await B.exited;
  }

  // Who may take a checklist back when looking again after startup.
  {
    const { ChecklistStore } = require(EXT + '/dist/model.js');
    const st = new ChecklistStore();
    st.handleTool('s', {}, 'checklist_add_tasks', { title: 'T', tasks: ['One'] });
    const have = JSON.parse(JSON.stringify(st.all()[0]));
    check(st.adopt(have) === undefined && st.all().length === 1, 'adopting a checklist this window already has changes nothing');
    const { Ownership } = require(EXT + '/dist/ownership.js');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbown-')), f = (id) => path.join(d, id + '.owner');
    const held = (id, rec) => fs.writeFileSync(f(id), JSON.stringify({ pid: process.pid, token: 'other', ...rec }));
    held('old'); // written by 0.5.0: names no window
    const o1 = new Ownership(d, process.pid, 'ws-1'); o1.claim('old'); fs.rmSync(f('old'));
    check(o1.claim('old', true), 'a folder window takes back a checklist an older version had claimed, once it is handed back');
    held('mine', { window: 'ws-1' });
    const o2 = new Ownership(d, process.pid, 'ws-1'); o2.claim('mine'); fs.rmSync(f('mine'));
    check(o2.claim('mine', true), 'a window takes back what its own earlier copy held');
    held('theirs', { window: 'ws-2' });
    const o3 = new Ownership(d, process.pid, 'ws-1'); o3.claim('theirs'); fs.rmSync(f('theirs'));
    check(!o3.claim('theirs', true), "a window does not take what a different window held when it closes");
    // The holder lets go before the checklist's own file exists, and we only noticed the claim before that.
    held('early', { window: 'ws-1' });
    const o5 = new Ownership(d, process.pid, 'ws-1'); o5.observe(); fs.rmSync(f('early'));
    check(o5.claim('early', true), 'a claim noticed before its checklist file exists still lets us take it back');
    held('unnoticed', { window: 'ws-1' }); fs.rmSync(f('unnoticed'));
    check(!new Ownership(d, process.pid, 'ws-1').claim('unnoticed', true), 'but one we never noticed is left alone');
    held('moved', { window: 'ws-2' });
    const o6 = new Ownership(d, process.pid, 'ws-1'); o6.observe(); held('moved', { window: 'ws-1' }); o6.observe(); fs.rmSync(f('moved'));
    check(o6.claim('moved', true), 'who held a checklist is kept up to date, not just noted once');
    held('legacy');
    const o4 = new Ownership(d, process.pid, 'empty-ab12'); o4.claim('legacy'); fs.rmSync(f('legacy'));
    check(!o4.claim('legacy', true), 'a folderless window never takes anything back this way');
  }

  const leftovers = fs.readdirSync(path.join(ST, 'checklists')).filter((f) => f.includes('.tmp'));
  check(!leftovers.length, 'no temp files left behind');
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
