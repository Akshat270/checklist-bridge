const __ROOT = require('path').resolve(__dirname, '..');
// Tests for the 0.4.1 fixes, against the real extension in a stand-in VS Code window.
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), net = require('net');
const EXT = __ROOT;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbfix-'));
process.env.CHECKLIST_BRIDGE_HOME = HOME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['unilytic', '/work/unilytic', EXT, path.join(HOME, 'st'), '1']);
const waiters = []; let windowId; const typed = []; const clip = [];
W.on('message', (m) => {
  if (m.windowId) windowId = m.windowId;
  if (m.termText !== undefined) typed.push(m.termText);
  if (m.clipboard !== undefined) clip.push(m.clipboard);
  const i = waiters.findIndex((x) => x.k in m); if (i >= 0) waiters.splice(i, 1)[0].r(m);
});
const wwait = (k) => new Promise((r) => waiters.push({ k, r }));
const panels = async () => (W.send({ cmd: 'panels' }), (await wwait('panels')).panels);
const panel = async (t) => (await panels()).find((p) => p.title === t);
const user = async (title, msg) => (W.send({ cmd: 'user', title, msg }), wwait('done'));

function chat(label, env = {}) {
  const p = spawn(process.execPath, [path.join(__dirname, 'harness', 'fakeclaude.js'), path.join(HOME, 'connector', 'connector.js')], {
    env: { ...process.env, CHECKLIST_BRIDGE_SESSION: label, CLAUDE_PROJECT_DIR: '/work/unilytic', CHECKLIST_BRIDGE_WINDOW: windowId, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0; const wait = {};
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id !== undefined && wait[m.id]) wait[m.id](m); } });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') }; };
  return { proc: p, rpc, tool };
}
const fakeWindow = (id, port) => {
  fs.mkdirSync(path.join(HOME, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'windows', id + '.json'), JSON.stringify({ windowId: id, port, token: 'x', pid: process.pid, folders: ['/elsewhere'], focusedAt: Date.now() + 1e6, name: id }));
};

(async () => {
  await wwait('ready');

  // ---- 1. Claude exits; its terminal (the shell) stays open. Send now must not type into it.
  const A = chat('A');
  await A.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 't' } });
  await sleep(1500); // process detection
  // The shell is this test process: an ancestor of the chat that outlives Claude, like a real terminal.
  W.send({ cmd: 'addTerminal', pid: process.pid }); await wwait('done');
  await A.tool('checklist_ask', { title: 'Alpha', questions: [{ question: 'Pick a name\r\nrm -rf ~ $(touch /tmp/pwned)\x1b[2J', options: ['Ledger', 'Atlas'] }] });
  // Process detection can take several seconds on Windows (PowerShell); wait for it rather than guess.
  let p;
  for (const t0 = Date.now(); Date.now() - t0 < 30_000; await sleep(250)) {
    p = await panel('Alpha');
    if (p && p.routes.terminal) break;
  }
  check(p.routes.terminal, 'while Claude runs in the terminal, Send now types into it');
  await user('Alpha', { type: 'answerDraft', qid: 'q1', picks: ['o1'] });
  await user('Alpha', { type: 'shareAnswer', qid: 'q1' });
  await user('Alpha', { type: 'sendNow' }); await sleep(500);
  check(typed.length === 2 && typed[1] === '\r', 'update typed, then Enter');
  check(typed[0] && !/[\x00-\x1f\x7f]/.test(typed[0]), 'no control characters reach the terminal: ' + JSON.stringify(typed[0]));
  await user('Alpha', { type: 'sendNow' }); await sleep(500);
  check(typed.length === 2, 'pressing Send now again does not type the same update twice');

  A.proc.kill(); await sleep(800);
  await A.tool?.call; // noop
  await user('Alpha', { type: 'unshareAnswer', qid: 'q1' });
  await user('Alpha', { type: 'answerDraft', qid: 'q1', picks: ['o2'] });
  await user('Alpha', { type: 'shareAnswer', qid: 'q1' });
  p = await panel('Alpha');
  check(!p.routes.terminal && !p.routes.channel, 'after Claude exits, the panel no longer offers the terminal route');
  const before = typed.length;
  await user('Alpha', { type: 'sendNow' }); await sleep(500);
  check(typed.length === before, 'Send now after Claude exits types nothing into the shell');
  check(clip.length === 1 && /Atlas/.test(clip[0]), 'it copies the update for the chat instead');

  // ---- 2. A chat stops waiting (connection dropped) right before the user shares: nothing is marked read.
  const B = chat('B');
  await B.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 't' } });
  await B.tool('checklist_ask', { title: 'Beta', questions: [{ question: 'Colour?', options: ['Red', 'Blue'] }] });
  B.rpc('tools/call', { name: 'checklist_wait', arguments: { timeout_minutes: 2 } });
  await sleep(400);
  check((await panel('Beta')).routes.waiting, 'panel shows Claude waiting');
  B.proc.kill('SIGKILL'); // connector's socket drops without a goodbye
  await sleep(600);
  await user('Beta', { type: 'answerDraft', qid: 'q1', picks: ['o2'] });
  await user('Beta', { type: 'shareAnswer', qid: 'q1' });
  await sleep(300);
  p = await panel('Beta');
  check(p.questions[0].answered && !p.questions[0].seen, 'an answer shared after the wait dropped stays unread for Claude');
  check(!p.routes.waiting, 'panel stops showing "waiting"');

  // ---- 3. Slow window: the call may have gone through, so it is not repeated in another window.
  const hang = net.createServer(() => {}); await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  fakeWindow('slow', hang.address().port);
  const C = chat('C', { CHECKLIST_BRIDGE_WINDOW: 'slow' });
  await C.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 't' } });
  let t0 = Date.now();
  let r = await C.tool('checklist_add_tasks', { title: 'Gamma', tasks: ['Do a thing'] });
  check(r.isError && /may or may not have gone through/.test(r.text), `slow window: add_tasks reports it instead of retrying (${Math.round((Date.now() - t0) / 1000)} s)`);
  check(!(await panel('Gamma')), 'no duplicate checklist was created in another window');
  r = await C.tool('checklist_read', {});
  check(!r.isError, 'checklist_read (read-only) still moves on to a working window');

  // ---- 4. A window that refuses the call (wrong token) never ran it, so moving on is safe.
  const refuse = http.createServer((q, s) => s.writeHead(403).end()); await new Promise((res) => refuse.listen(0, '127.0.0.1', res));
  fakeWindow('refuse', refuse.address().port);
  const D = chat('D', { CHECKLIST_BRIDGE_WINDOW: 'refuse' });
  await D.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 't' } });
  r = await D.tool('checklist_add_tasks', { title: 'Delta', tasks: ['Another thing'] });
  check(!r.isError && !!(await panel('Delta')), 'refused by one window: tasks land in the working window');

  hang.close(); refuse.close(); C.proc.kill(); D.proc.kill();
  W.send({ cmd: 'quit' });
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  setTimeout(() => process.exit(failed ? 1 : 0), 700);
})().catch((e) => { console.error(e); process.exit(1); });
