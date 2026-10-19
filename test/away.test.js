const __ROOT = require('path').resolve(__dirname, '..');
// "I'll be away": Claude stops waiting for the user. Nothing wakes Claude when they come back.
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const EXT = __ROOT;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbaway-'));
process.env.CHECKLIST_BRIDGE_HOME = HOME;
process.env.CHECKLIST_BRIDGE_AWAY_TICK_MS = '500'; // how often the window ends aways that ran out (test only)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['away', '/work/away', EXT, path.join(HOME, 'st'), '1']);
const waiters = [];
let windowId;
W.on('message', (m) => {
  if (m.windowId) windowId = m.windowId;
  const i = waiters.findIndex((x) => x.k in m);
  if (i >= 0) waiters.splice(i, 1)[0].r(m);
});
const wwait = (k) => new Promise((r) => waiters.push({ k, r }));
const panel = async (title) => (W.send({ cmd: 'panels' }), (await wwait('panels')).panels.find((p) => p.title === title));
const user = async (title, msg) => (W.send({ cmd: 'user', title, msg }), wwait('done'));

function chat(label, flags = []) {
  const p = spawn(process.execPath, [path.join(__dirname, 'harness', 'fakeclaude.js'), ...flags, path.join(HOME, 'connector', 'connector.js')], {
    env: { ...process.env, CHECKLIST_BRIDGE_SESSION: label, CLAUDE_PROJECT_DIR: '/work/away', CHECKLIST_BRIDGE_WINDOW: windowId },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', id = 0; const wait = {}; const notes = [];
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id !== undefined && wait[m.id]) wait[m.id](m); else notes.push(m);
    }
  });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args, _meta: { progressToken: label } })).result;
    return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
  };
  return { rpc, tool, notes, kill: () => p.kill() };
}
const init = (c) => c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'x' } });
const allNotes = (c) => c.notes.filter((n) => n.method === 'notifications/claude/channel');

(async () => {
  await wwait('ready');

  // ---------- A: a plain chat
  const A = chat('A');
  await init(A);
  await A.tool('checklist_ask', { title: 'Deploy', questions: [{ question: 'Which region?', options: ['Mumbai', 'Singapore'] }] });
  let r = await A.tool('checklist_read', {});
  check(!/AWAY/.test(r.text), 'not away: nothing about being away in the checklist');

  // Claude is already waiting when the user leaves: the wait ends at once.
  const waiting = A.tool('checklist_wait', { timeout_minutes: 5 });
  await sleep(400);
  let t0 = Date.now();
  await user('Deploy', { type: 'setAway', ms: 3600_000 });
  r = await waiting;
  check(/THE USER IS AWAY/.test(r.text) && /do not call checklist_wait/i.test(r.text) && Date.now() - t0 < 2000, `a running wait is released when the user goes away (${Date.now() - t0} ms)`);
  check((await panel('Deploy')).away === true, 'the panel shows the user as away');
  {
    const pa = await panel('Deploy');
    check(Math.abs(pa.awayLeft - 3600_000) < 10_000 && pa.awayMs === 3600_000, `the panel is told how long is left (${pa.awayLeft} ms of ${pa.awayMs} ms)`);
  }

  t0 = Date.now();
  r = await A.tool('checklist_wait', { timeout_minutes: 5 });
  check(/THE USER IS AWAY/.test(r.text) && Date.now() - t0 < 2000, 'checklist_wait does not block while the user is away');
  r = await A.tool('checklist_read', {});
  check(/THE USER IS AWAY/.test(r.text) && /Which region/.test(r.text), 'checklist_read says the user is away and still lists what is waiting');
  r = await A.tool('checklist_add_tasks', { tasks: ['Add the DNS record'] });
  check(/THE USER IS AWAY/.test(r.text), 'adding a task also says the user is away');
  r = await A.tool('checklist_ask', { questions: [{ question: 'Which plan?', options: ['Free', 'Pro'] }] });
  check(/THE USER IS AWAY/.test(r.text), 'asking a question also says the user is away');

  // The countdown is exact, not rounded: 95 minutes is "1 hour 35 minutes", not "about 2 hours".
  await user('Deploy', { type: 'endAway' });
  await user('Deploy', { type: 'setAway', ms: 95 * 60_000, label: '3:17 PM' });
  r = await A.tool('checklist_read', {});
  check(/AWAY until 3:17 PM \(in 1 hour 35 minutes\)/.test(r.text), 'Claude is told the end time as the user saw it, and the time left exactly');
  r = await A.tool('checklist_edit', { title: 'Deploy' });
  check(/THE USER IS AWAY/.test(r.text), 'checklist_edit also tells Claude the user is away');
  await user('Deploy', { type: 'setAway', ms: 30 * 60_000 });

  // The user comes back early.
  await user('Deploy', { type: 'endAway' });
  check((await panel('Deploy')).away === false, 'I\'m back clears away in the panel');
  r = await A.tool('checklist_read', {});
  check(!/AWAY/.test(r.text), 'after I\'m back, Claude is no longer told the user is away');
  let blocked = true;
  A.tool('checklist_wait', { timeout_minutes: 1 }).then(() => (blocked = false));
  await sleep(700);
  check(blocked, 'after I\'m back, checklist_wait waits for the user again');

  // Times that make no sense are refused.
  await user('Deploy', { type: 'setAway', ms: -60_000 });
  await user('Deploy', { type: 'setAway', ms: 3 * 24 * 3600_000 });
  await user('Deploy', { type: 'setAway', ms: 'soon' });
  check((await panel('Deploy')).away === false, 'a past time, more than a day ahead, or not a time is refused');

  // ---------- B: started with channels. It is told when the user is back.
  const B = chat('B', ['--dangerously-load-development-channels', 'server:checklist']);
  await init(B);
  await B.tool('checklist_ask', { title: 'Naming', questions: [{ question: 'Name it?', options: ['A', 'B'] }] });
  await sleep(1500);
  check((await panel('Naming')).routes?.channel === true, 'channel route detected');

  // Nothing is sent to Claude when the user comes back: an idle chat's cache has usually expired,
  // so waking it would cost the user. Claude finds out on its next read.
  await user('Naming', { type: 'setAway', ms: 3600_000 });
  r = await B.tool('checklist_read', {});
  check(/THE USER IS AWAY/.test(r.text), 'a chat on channels is told the user is away');
  await user('Naming', { type: 'endAway' });
  await sleep(800);
  check(allNotes(B).length === 0, 'I\'m back sends nothing to Claude');
  r = await B.tool('checklist_read', {});
  check(!/AWAY/.test(r.text), 'Claude learns the user is back on its next read');

  // The time runs out by itself: also silent.
  await user('Naming', { type: 'setAway', ms: 1500 });
  r = await B.tool('checklist_read', {});
  check(/THE USER IS AWAY/.test(r.text), 'a short away is seen by Claude');
  await sleep(3000);
  r = await B.tool('checklist_read', {});
  check(!/AWAY/.test(r.text), 'when the time is up, Claude is no longer told the user is away');
  await sleep(1500); // past the timer that clears the state (set short for tests)
  check((await panel('Naming')).away === false, 'the panel is no longer away');
  check(allNotes(B).length === 0, 'the time running out sends nothing to Claude either');

  // Straight on the store: no timers, no windows.
  {
    const { ChecklistStore, normalize } = require(EXT + '/dist/model.js');
    const st = new ChecklistStore();
    st.handleTool('s', {}, 'checklist_add_tasks', { tasks: ['x'] });
    const c = st.all()[0];
    check(st.setAway(c.id, 60_000, 'bad <script>label') && c.awayLabel === 'bad scriptlabel', 'the label is cleaned before Claude sees it');
    check(!st.setAway(c.id, 0) && !st.setAway(c.id, 25 * 3600_000) && !st.setAway(c.id, NaN), 'zero, over a day, and not-a-number are refused');
    const events = []; st.onChange((e) => events.push(e.kind));
    c.awayUntil = Date.now() - 1000;
    st.expireAway(); st.expireAway();
    check(c.awayUntil === undefined && events.length === 1, 'an away that ran out is ended once');
    const stale = JSON.parse(JSON.stringify({ ...c, awayUntil: Date.now() - 5000, awayLabel: '1:00 PM' }));
    check(normalize(stale).awayUntil === undefined && normalize(stale).awayLabel === undefined, 'an away that ran out while the window was closed is dropped when loading');
    st.setAway(c.id, 60_000, '1:00 PM'); events.length = 0;
    st.close(c.id);
    check(c.awayUntil === undefined && !st.isAway(c), 'closing a checklist ends its away');
    // a listener that throws must not stop expiry for the others
    const st2 = new ChecklistStore();
    st2.handleTool('a', {}, 'checklist_add_tasks', { tasks: ['x'] });
    st2.handleTool('b', {}, 'checklist_add_tasks', { tasks: ['y'] });
    for (const x of st2.all()) x.awayUntil = Date.now() - 1;
    st2.onChange(() => { throw new Error('boom'); });
    let threw = false; try { st2.expireAway(); } catch { threw = true; }
    check(threw, 'a failing listener surfaces from expireAway (the window catches it around the timer)');
  }

  [A, B].forEach((c) => c.kill());
  W.send({ cmd: 'quit' });
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  setTimeout(() => process.exit(failed ? 1 : 0), 700);
})();
