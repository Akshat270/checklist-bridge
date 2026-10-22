const __ROOT = require('path').resolve(__dirname, '..');
// Two VS Code windows (Unilytic, Atlas), three Claude chats. Checks the checklist lands in the right window,
// chats in one window get separate checklists, hide/show/close, and survival across a window reload.
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const EXT = __ROOT;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbe-'));
process.env.CHECKLIST_BRIDGE_HOME = HOME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

const opened = [];
const winIds = {};
const firstLog = {}; // the first line each window writes to its Output channel
function win(name, folder, focused) {
  const w = fork(path.join(__dirname, 'harness', 'fakewin.js'), [name, folder, EXT, path.join(HOME, 'storage-' + name), focused ? '1' : '0']);
  const waiters = [];
  w.on('message', (m) => {
    if (m.panelOpened) opened.push(`${m.window}:${m.panelOpened}`);
    if (m.windowId) winIds[name] = m.windowId;
    if (m.log && !(name in firstLog) && m.log.startsWith(`[${name}] [`)) firstLog[name] = m.log;
    if (process.env.VERBOSE && m.log) console.log('   ' + m.log);
    const i = waiters.findIndex((x) => x.k in m);
    if (i >= 0) waiters.splice(i, 1)[0].r(m);
  });
  const wait = (k) => new Promise((r) => waiters.push({ k, r }));
  return {
    ready: wait('ready'),
    panels: async () => (w.send({ cmd: 'panels' }), (await wait('panels')).panels),
    user: async (title, msg) => (w.send({ cmd: 'user', title, msg }), wait('done')),
    closeTab: async (title) => (w.send({ cmd: 'closeTab', title }), wait('done')),
    clickItem: async (title) => (w.send({ cmd: 'clickItem', title }), wait('done')),
    command: async (name, args) => (w.send({ cmd: 'command', name, args }), wait('done')),
    focus: () => w.send({ cmd: 'focus' }),
    quit: () => new Promise((r) => { w.on('exit', r); w.send({ cmd: 'quit' }); }),
  };
}

function chat(label, cwd, env = {}) {
  const p = spawn(process.execPath, [path.join(HOME, 'connector', 'connector.js')], {
    env: { ...process.env, CHECKLIST_BRIDGE_SESSION: label, CLAUDE_PROJECT_DIR: cwd, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', id = 0; const wait = {};
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id]?.(m); } });
  p.stderr.on('data', (d) => process.stdout.write(`   ${label}: ${d}`));
  const tool = (name, args) => new Promise((r) => { const n = ++id; wait[n] = (m) => r(m.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
  return { tool, kill: () => p.kill() };
}

(async () => {
  let U = win('unilytic', '/work/unilytic', false);
  const A = win('atlas', '/work/atlas', true); // Atlas was opened last / focused
  await U.ready; await A.ready;
  // The first line in the Output says which copy is running and where it was loaded from, so a test build is easy to tell apart.
  const version = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8')).version;
  check(firstLog.unilytic?.endsWith(`Checklist Bridge ${version}, loaded from ${EXT}`), `the Output starts with the version and folder (${firstLog.unilytic})`);
  check(fs.existsSync(path.join(HOME, 'connector', 'connector.js')), 'connector copied to a stable place for Claude Code');

  // Chat 1: Claude Code panel inside the Unilytic window -> inherits the window id from the extension host.
  const c1 = chat('c1', '/work/unilytic', { CHECKLIST_BRIDGE_WINDOW: winIds.unilytic });
  // Chat 2: second agent in the same Unilytic window.
  const c2 = chat('c2', '/work/unilytic', { CHECKLIST_BRIDGE_WINDOW: winIds.unilytic });
  // Chat 3: claude started from an outside terminal in the Atlas folder (no window id) -> folder match.
  const c3 = chat('c3', '/work/atlas/packages/app');

  await c1.tool('checklist_add_tasks', { title: 'Supabase setup', tasks: ['Create project', 'Copy key'] });
  await c2.tool('checklist_add_tasks', { title: 'SP-API keys', tasks: [{ text: 'Get refresh token', tags: ['urgent'] }] });
  await c3.tool('checklist_add_tasks', { title: 'Atlas release', tasks: ['Bump version'] });
  await sleep(200);
  console.log('   panels opened:', opened.join(', '));
  check(opened.includes('unilytic:Supabase setup') && opened.includes('unilytic:SP-API keys'),
    'both Unilytic chats open in the Unilytic window even though Atlas was focused last');
  check((await U.panels()).length === 2, 'two separate checklists side by side in that window');
  check(opened.includes('atlas:Atlas release'), 'chat in the Atlas folder opens in the Atlas window');

  // User shares "Create project" in the Supabase checklist; the other chat must not see it.
  const list1 = (await U.panels()).find((p) => p.title === 'Supabase setup');
  await U.user('Supabase setup', { type: 'share', taskId: 't1', done: true, note: 'project unilytic-prod' });
  let r = await c1.tool('checklist_read', {});
  check(/t1 Create project: DONE/.test(r) && /unilytic-prod/.test(r), 'chat 1 reads the shared task + note');
  r = await c2.tool('checklist_read', {});
  check(!/Create project/.test(r), 'chat 2 sees only its own checklist');

  // Hide via tab close, Claude adds more -> stays hidden, notification instead.
  await U.closeTab('SP-API keys');
  await c2.tool('checklist_add_tasks', { tasks: ['Add marketplace IDs'] });
  await sleep(150);
  check(!(await U.panels()).some((p) => p.title === 'SP-API keys'), 'hidden checklist stays hidden when Claude adds tasks');
  await U.command('checklistBridge.showAll');
  check((await U.panels()).some((p) => p.title === 'SP-API keys' && p.tasks.length === 2), 'Show all brings it back with the new task');

  // Clicking a checklist in the sidebar list opens it; clicking one that is already open must not close it.
  await U.clickItem('SP-API keys');
  check((await U.panels()).some((p) => p.title === 'SP-API keys'), 'clicking an open checklist in the list keeps it open');

  // Reload the Unilytic window: checklists restored, chat 1 keeps working with its checklist.
  await U.quit();
  U = win('unilytic', '/work/unilytic', true);
  await U.ready;
  await sleep(1800); // the extension reopens tabs VS Code didn't restore itself after 1.5 s
  const restored = await U.panels();
  check(restored.length === 2, 'after a window reload both checklists come back');
  r = await c1.tool('checklist_add_tasks', { tasks: ['Run migrations'] });
  check(/\(t3\)/.test(r), 'the same chat keeps adding to its restored checklist (t3)');
  check((await U.panels()).find((p) => p.title === 'Supabase setup').tasks.join() === 't1*,t2,t3', 'restored list keeps shared state');

  // Close for good.
  await U.user('Supabase setup', { type: 'close' });
  await sleep(100);
  r = await c1.tool('checklist_read', {});
  check(/CLOSED by the user/.test(r), 'closing tells Claude');

  [c1, c2, c3].forEach((c) => c.kill());
  await U.quit(); await A.quit();
  check(!fs.readdirSync(path.join(HOME, 'windows')).length, 'windows unregister when VS Code closes');
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
