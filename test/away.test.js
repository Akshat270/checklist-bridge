const __ROOT = require('path').resolve(__dirname, '..');
// "I'll be away": Claude stops waiting for the user, and is told when they are back.
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const EXT = __ROOT;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbaway-'));
process.env.CHECKLIST_BRIDGE_HOME = HOME;
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
const backNotes = (c) => c.notes.filter((n) => n.method === 'notifications/claude/channel' && /I'm back/.test(n.params.content));

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
  await user('Deploy', { type: 'setAway', until: Date.now() + 3600_000 });
  r = await waiting;
  check(/THE USER IS AWAY/.test(r.text) && /do not call checklist_wait/i.test(r.text) && Date.now() - t0 < 2000, `a running wait is released when the user goes away (${Date.now() - t0} ms)`);
  check((await panel('Deploy')).away === true, 'the panel shows the user as away');

  t0 = Date.now();
  r = await A.tool('checklist_wait', { timeout_minutes: 5 });
  check(/THE USER IS AWAY/.test(r.text) && Date.now() - t0 < 2000, 'checklist_wait does not block while the user is away');
  r = await A.tool('checklist_read', {});
  check(/THE USER IS AWAY/.test(r.text) && /Which region/.test(r.text), 'checklist_read says the user is away and still lists what is waiting');
  r = await A.tool('checklist_add_tasks', { tasks: ['Add the DNS record'] });
  check(/THE USER IS AWAY/.test(r.text), 'adding a task also says the user is away');
  r = await A.tool('checklist_ask', { questions: [{ question: 'Which plan?', options: ['Free', 'Pro'] }] });
  check(/THE USER IS AWAY/.test(r.text), 'asking a question also says the user is away');

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
  await user('Deploy', { type: 'setAway', until: Date.now() - 60_000 });
  await user('Deploy', { type: 'setAway', until: Date.now() + 3 * 24 * 3600_000 });
  await user('Deploy', { type: 'setAway', until: 'soon' });
  check((await panel('Deploy')).away === false, 'a past time, more than a day ahead, or not a time is refused');

  // ---------- B: started with channels. It is told when the user is back.
  const B = chat('B', ['--dangerously-load-development-channels', 'server:checklist']);
  await init(B);
  await B.tool('checklist_ask', { title: 'Naming', questions: [{ question: 'Name it?', options: ['A', 'B'] }] });
  await sleep(1500);
  check((await panel('Naming')).routes?.channel === true, 'channel route detected');

  await user('Naming', { type: 'setAway', until: Date.now() + 3600_000 });
  await B.tool('checklist_read', {});
  await user('Naming', { type: 'endAway' });
  await sleep(800);
  check(backNotes(B).length === 1, 'Claude is told the user is back when they press I\'m back');

  // The time runs out by itself.
  await user('Naming', { type: 'setAway', until: Date.now() + 2500 });
  r = await B.tool('checklist_read', {});
  check(/THE USER IS AWAY/.test(r.text), 'a short away is seen by Claude');
  await sleep(3000);
  r = await B.tool('checklist_read', {});
  check(!/AWAY/.test(r.text), 'when the time is up, Claude is no longer told the user is away');
  const t1 = Date.now();
  while (backNotes(B).length < 2 && Date.now() - t1 < 25_000) await sleep(500);
  check(backNotes(B).length === 2, 'Claude is told the user is back when the time runs out');
  check((await panel('Naming')).away === false, 'the panel is no longer away');

  // A chat that was never told the user was away does not get a message.
  const C = chat('C', ['--dangerously-load-development-channels', 'server:checklist']);
  await init(C);
  await C.tool('checklist_ask', { title: 'Quiet', questions: [{ question: 'Q?', options: ['A', 'B'] }] });
  await sleep(1500);
  await user('Quiet', { type: 'setAway', until: Date.now() + 3600_000 });
  await sleep(200);
  await user('Quiet', { type: 'endAway' });
  await sleep(800);
  check(backNotes(C).length === 0, 'no "I\'m back" message for a chat that never heard the user was away');

  [A, B, C].forEach((c) => c.kill());
  W.send({ cmd: 'quit' });
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  setTimeout(() => process.exit(failed ? 1 : 0), 700);
})();
