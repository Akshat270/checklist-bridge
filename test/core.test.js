const __ROOT = require('path').resolve(__dirname, '..');
// Two chats (two connector processes) -> one VS Code window. Checks separation, sharing rules, images, edits.
const path = require('path'), fs = require('fs'), os = require('os'), { spawn } = require('child_process');
const DIST = __ROOT + '/dist';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
process.env.CHECKLIST_BRIDGE_HOME = HOME;
const { ChecklistStore } = require(DIST + '/model.js');
const { createWindowServer } = require(DIST + '/windowServer.js');
const { writeWindow } = require(DIST + '/registry.js');

const store = new ChecklistStore();
const events = [];
store.onChange((e) => events.push(e.kind));
const ws = createWindowServer(store, 'secret');
const server = ws.server;
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; };

function chat(name, extraEnv = {}) {
  const p = spawn(process.execPath, [DIST + '/connector.js'], {
    env: { ...process.env, CHECKLIST_BRIDGE_SESSION: name, CLAUDE_PROJECT_DIR: '/work/unilytic', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', id = 0; const waiting = {};
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting[m.id]?.(m); } });
  p.stderr.on('data', (d) => process.stdout.write('   ' + name + ' stderr: ' + d));
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waiting[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (n, a) => (await rpc('tools/call', { name: n, arguments: a })).result;
  return { rpc, tool, kill: () => p.kill() };
}
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

server.listen(0, '127.0.0.1', async () => {
  writeWindow({ windowId: 'w-unilytic', port: server.address().port, token: 'secret', pid: process.pid, folders: ['/work/unilytic'], focusedAt: Date.now(), name: 'unilytic' });

  const A = chat('chatA'), B = chat('chatB');
  const init = await A.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'x' } });
  check(!!init.result.instructions, 'initialize returns server instructions');
  const tl = await A.rpc('tools/list', {});
  check(tl.result.tools.map((t) => t.name).join() === 'checklist_add_tasks,checklist_ask,checklist_read,checklist_wait,checklist_edit', 'five tools listed');

  let r = await A.tool('checklist_add_tasks', { title: 'Supabase setup', tasks: [
    { text: 'Create a Supabase project', tags: ['Urgent'], group: 'Database' },
    { text: 'Copy the service key into .env.local', command: 'SUPABASE_SERVICE_ROLE_KEY=', group: 'Database' },
    { text: 'Tell me if login works' },
  ] });
  check(/Added 3 tasks \(t1–t3\)/.test(text(r)), 'chat A adds t1–t3: ' + text(r).split('\n')[0]);
  r = await B.tool('checklist_add_tasks', { title: 'Deploy', tasks: ['Push to main'] });
  check(/t1\)/.test(text(r)), 'chat B gets its own checklist starting at t1');
  check(store.all().length === 2, 'window now has 2 separate checklists');

  const a = store.all().find((c) => c.title === 'Supabase setup');
  // user ticks t1 and t2, adds note, shares only t1
  store.setDraft(a.id, 't1', { done: true, note: 'Mumbai region' });
  store.setDraft(a.id, 't2', { done: true, note: 'secret stuff' });
  store.addImages(a.id, 't1', [{ mime: 'image/png', data: 'iVBORw0KGgo=', w: 10, h: 10 }]);
  store.share(a.id, 't1');

  r = await A.tool('checklist_read', {});
  const t = text(r);
  console.log('---- read #1 ----\n' + t + '\n-----------------');
  check(/t1 Create a Supabase project \[urgent\]: DONE/.test(t), 'shared t1 reported as DONE with tag');
  check(/Mumbai region/.test(t), 'shared note included');
  check(!/secret stuff/.test(t) && /waiting on the user[\s\S]*t2/i.test(t), 'ticked-but-unshared t2 stays private, listed as waiting');
  check(r.content.some((c) => c.type === 'image'), 'screenshot sent as image content');
  check(store.get(a.id).tasks[0].seenAt > 0, 'panel can show "seen by Claude"');

  r = await A.tool('checklist_read', {});
  check(/Nothing new since your last read/.test(text(r)) && !r.content.some((c) => c.type === 'image'), 'second read: nothing new, no repeated images');

  store.unshare(a.id, 't1');
  r = await A.tool('checklist_read', {});
  check(/took this back/.test(text(r)), 'withdrawing a seen task is reported once');

  r = await B.tool('checklist_read', {});
  check(!/Supabase/.test(text(r)) && /Deploy/.test(text(r)), "chat B can't see chat A's checklist");

  r = await A.tool('checklist_edit', { updates: [{ id: 't3', add_tags: ['important'], group: 'Testing' }], group_order: ['Testing', 'Database'] });
  check(store.get(a.id).tasks[2].tags.includes('important') && store.get(a.id).groupOrder[0] === 'Testing', 'edit adds tag, group and reorders groups');

  store.close(a.id);
  r = await A.tool('checklist_read', {});
  check(/CLOSED by the user/.test(text(r)), 'Claude is told when the user closed the checklist');
  r = await A.tool('checklist_add_tasks', { tasks: ['Something new'] });
  check(store.all().filter((c) => c.sessionId.startsWith('chatA')).length === 1 && store.all().some((c) => c.title === 'Things to do'), 'adding after close starts a fresh checklist');

  // Handing the checklists to the Claude Code mod ends a wait under way, and says why; so does the next one.
  {
    const W = chat('chatW'), K = chat('chatK');
    await W.tool('checklist_add_tasks', { tasks: ['Wait on me'] });
    await K.tool('checklist_add_tasks', { tasks: ['Kept here'] });
    const waiting = W.tool('checklist_wait', { timeout_minutes: 5 });
    let keptDone = false;
    const keptWait = K.tool('checklist_wait', { timeout_minutes: 1 }).then((r) => ((keptDone = true), r));
    await new Promise((r) => setTimeout(r, 300));
    store.lockedNote = 'Moved to the mod.';
    store.keptHere = new Set(store.all().filter((c) => c.sessionId.startsWith('chatK')).map((c) => c.id)); // its export failed
    ws.endWaits((sid) => store.lockedFor(store.forSession(sid), sid));
    check(text(await waiting) === 'Moved to the mod.', 'a wait under way ends when the checklists go to the mod');
    await new Promise((r) => setTimeout(r, 200));
    check(!keptDone, 'but not the wait on a checklist that stays usable here');
    store.keptHere = new Set();
    check(text(await W.tool('checklist_wait', {})) === 'Moved to the mod.', 'and a new wait says so, not that nothing is waiting');
    store.lockedNote = undefined;
    store.share(store.all().find((c) => c.sessionId.startsWith('chatK')).id, 't1');
    check(!/Moved to the mod/.test(text(await keptWait)), 'which ends as usual, with the user\'s update');
    W.kill(); K.kill();
  }

  // A chat that gives no process (the mod passing calls on) counts as reachable only while it keeps coming back.
  {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/call`, { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ sessionId: 'mod-chat', tool: '__hello' }) });
    check(res.status === 200 && ws.isAlive('mod-chat'), 'a chat without a process is reachable while it calls');
    ws.sessions.get('mod-chat').lastSeen = Date.now() - 3 * 60_000;
    check(!ws.isAlive('mod-chat') && ws.prune() && !ws.sessions.has('mod-chat'), 'and is dropped once it has been quiet for minutes');
  }

  // window goes away -> clear error, no hang
  server.close(); server.closeAllConnections();
  fs.rmSync(path.join(HOME, 'windows'), { recursive: true });
  r = await A.tool('checklist_read', {});
  check(r.isError && /no VS Code window/.test(text(r)), 'helpful error when VS Code is not running');

  // A window's folder is compared as the chat's is, made absolute and tidied (on Windows, /work/x is D:\work\x):
  // the window with the project open wins over one used more recently.
  const { pickWindow } = require(DIST + '/registry.js');
  writeWindow({ windowId: 'w-dots', port: 1, token: 't', pid: process.pid, folders: ['/work/other/../dotted'], focusedAt: 1, name: 'dots' });
  writeWindow({ windowId: 'w-recent', port: 2, token: 't', pid: process.pid, folders: ['/elsewhere'], focusedAt: Date.now() + 1e6, name: 'recent' });
  const picked = pickWindow({}, '/work/dotted');
  check(picked?.w.windowId === 'w-dots' && picked.w.folders[0] === '/work/other/../dotted', `the window with the chat's folder open is picked: ${picked?.w.windowId} (${picked?.why})`);

  A.kill(); B.kill();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
});
