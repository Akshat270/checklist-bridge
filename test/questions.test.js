const __ROOT = require('path').resolve(__dirname, '..');
// Questions + "Send now": one VS Code window, three chats, each reachable a different way.
const { fork, spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const EXT = __ROOT;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbq-'));
process.env.CHECKLIST_BRIDGE_HOME = HOME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

// ---- fake VS Code window
const winEvents = [];
const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['unilytic', '/work/unilytic', EXT, path.join(HOME, 'st'), '1']);
const waiters = [];
let windowId;
W.on('message', (m) => {
  if (m.windowId) windowId = m.windowId;
  if (process.env.VERBOSE && m.log) console.log('   ' + m.log);
  winEvents.push(m);
  const i = waiters.findIndex((x) => x.k in m);
  if (i >= 0) waiters.splice(i, 1)[0].r(m);
});
const wwait = (k) => new Promise((r) => waiters.push({ k, r }));
const panels = async () => (W.send({ cmd: 'panels' }), (await wwait('panels')).panels);
const user = async (title, msg) => (W.send({ cmd: 'user', title, msg }), wwait('done'));
const panel = async (title) => (await panels()).find((p) => p.title === title);

// ---- fake Claude chats
function chat(label, flags = []) {
  const p = spawn(process.execPath, [path.join(__dirname, 'harness', 'fakeclaude.js'), ...flags, path.join(HOME, 'connector', 'connector.js')], {
    env: { ...process.env, CHECKLIST_BRIDGE_SESSION: label, CLAUDE_PROJECT_DIR: '/work/unilytic', CHECKLIST_BRIDGE_WINDOW: windowId },
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
  if (process.env.VERBOSE) p.stderr.on('data', (d) => process.stdout.write(`   ${label}: ${d}`));
  const rpc = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args, _meta: { progressToken: label } })).result;
    return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
  };
  return { pid: p.pid, rpc, tool, notes, kill: () => p.kill() };
}

const Q = (label, extra = {}) => ({
  question: 'Which payment gateway should Unilytic subscriptions use?',
  why: 'Decides the checkout page and GST invoices.',
  options: [
    { label: 'Razorpay', summary: 'UPI and cards, GST invoices', details: 'UPI Autopay for subscriptions; 2% per transaction.' },
    { label: 'Stripe', summary: 'Better global support' },
  ],
  recommended: 'Razorpay',
  reason: 'Most of your sellers pay with UPI.',
  ...extra,
});

(async () => {
  console.log('waiting for window'); await wwait('ready'); console.log('window ready');

  // ---------- A: plain chat (VS Code panel style). Ask, wait, answer.
  const A = chat('A');
  const init = await A.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'x' } });
  check(init.result.capabilities.experimental?.['claude/channel'], 'connector declares the claude/channel capability');
  check(/checklist_ask/.test(init.result.instructions), 'server instructions tell Claude when to ask in the checklist');

  let r = await A.tool('checklist_ask', { title: 'Billing', questions: [{ question: 'Bad', options: ['Only one'] }] });
  check(r.isError && /at least 2 options/.test(r.text), 'a question with one option is rejected');
  r = await A.tool('checklist_ask', { title: 'Billing', questions: [Q('A', { recommended: 'Paddle' })] });
  check(/Asked 1 question \(q1\)/.test(r.text) && /doesn't match an option/.test(r.text), 'ask creates q1 and flags an unknown recommendation');
  await A.tool('checklist_edit', { question_updates: [{ id: 'q1', recommended: 'Razorpay', reason: 'UPI' }] });
  let p = await panel('Billing');
  check(p && p.questions[0].id === 'q1' && !p.questions[0].answered, 'the question shows in the Billing checklist');

  await user('Billing', { type: 'answerDraft', qid: 'q1', picks: ['o1'], note: 'draft thought' });
  r = await A.tool('checklist_read', {});
  check(/Questions waiting for the user's decision:[\s\S]*q1/.test(r.text) && !/draft thought/.test(r.text), 'an unshared pick stays private; question listed as waiting');

  // Claude has nothing else to do: it waits.
  const waiting = A.tool('checklist_wait', { timeout_minutes: 2 });
  await sleep(400);
  p = await panel('Billing');
  check(p.routes?.waiting === true, 'panel knows Claude is waiting (Send now not needed)');
  const t0 = Date.now();
  await user('Billing', { type: 'shareAnswer', qid: 'q1', picks: ['o1'], note: 'Go with UPI Autopay' });
  r = await waiting;
  check(/ANSWER: Razorpay/.test(r.text) && /Go with UPI Autopay/.test(r.text) && Date.now() - t0 < 2000, `waiting Claude gets the answer immediately (${Date.now() - t0} ms)`);
  p = await panel('Billing');
  check(p.questions[0].answered && p.questions[0].seen && p.routes.waiting === false, 'answer marked as seen; waiting cleared');

  await user('Billing', { type: 'unshareAnswer', qid: 'q1' });
  r = await A.tool('checklist_read', {});
  check(/took back their answer/.test(r.text), 'taking back a seen answer is reported');

  // Copy fallback: nothing can reach A while it's idle.
  await A.tool('checklist_ask', { questions: [{ question: 'Free plan marketplaces?', options: ['2', '5'] }] });
  await user('Billing', { type: 'shareAnswer', qid: 'q2', picks: ['o2'] });
  W.send({ cmd: 'user', title: 'Billing', msg: { type: 'sendNow' } });
  const clip = await wwait('clipboard');
  check(/I answered q2/.test(clip.clipboard) && !/\n/.test(clip.clipboard), 'idle panel chat: Send now copies a one-line message for the chat');

  await A.tool('checklist_edit', { withdraw_questions: ['q1'], withdraw_reason: 'Decided in the pricing doc' });
  p = await panel('Billing');
  check(p.questions.find((q) => q.id === 'q1').retired, 'Claude can withdraw a question it no longer needs');
  r = await A.tool('checklist_read', {});
  check(!/q1 Which payment/.test(r.text.split('Decided earlier')[0].split('Questions waiting')[1] ?? ''), 'withdrawn question no longer listed as waiting');

  // ---------- B: started with channels on. Send now pushes into the chat.
  const B = chat('B', ['--dangerously-load-development-channels', 'server:checklist']);
  await B.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'x' } });
  await B.tool('checklist_ask', { title: 'Hosting', questions: [Q('B', { question: 'Vercel or Render?', options: ['Vercel', 'Render'], recommended: undefined })] });
  await sleep(1500); // process detection + first poll
  p = await panel('Hosting');
  check(p.routes?.channel === true, 'chat started with channels: route detected');
  await user('Hosting', { type: 'shareAnswer', qid: 'q1', picks: ['o2'], note: 'cheaper for cron jobs' });
  await user('Hosting', { type: 'sendNow' });
  await sleep(800);
  const pushed = B.notes.find((n) => n.method === 'notifications/claude/channel');
  check(pushed && /Answer: Render/.test(pushed.params.content) && /cheaper for cron jobs/.test(pushed.params.content), 'Send now pushes the answer into the chat as a channel event');
  p = await panel('Hosting');
  check(p.questions[0].pushed && !p.questions[0].seen, 'panel shows it as sent (not yet read)');

  // ---------- C: Claude running inside a VS Code terminal. Send now types into it.
  const C = chat('C');
  await C.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'x' } });
  await C.tool('checklist_ask', { title: 'Naming', questions: [{ question: 'Name the ledger page?', options: ['Inventory Ledger', 'Stock Ledger'] }] });
  await sleep(800);
  W.send({ cmd: 'addTerminal', pid: C.pid }); // the terminal's shell is an ancestor of the connector
  await wwait('done');
  p = await panel('Naming');
  check(p.routes?.terminal === true, 'chat in a VS Code terminal: its terminal is found');
  await user('Naming', { type: 'shareAnswer', qid: 'q1', picks: ['other'], other: 'Stock Movements' });
  W.send({ cmd: 'user', title: 'Naming', msg: { type: 'sendNow' } });
  const typed = await wwait('termText');
  const enter = await wwait('termText');
  check(/I answered q1 .*Something else: \\?"Stock Movements/.test(typed.termText) && enter.termText === '\r', 'Send now types a one-line update into that terminal, then presses Enter');

  // ---------- progress keeps long waits alive
  const D = chat('D');
  await D.tool('checklist_add_tasks', { title: 'Keys', tasks: ['Create key'] });
  const w2 = D.tool('checklist_wait', { timeout_minutes: 1 });
  await sleep(31_500);
  check(D.notes.some((n) => n.method === 'notifications/progress'), 'checklist_wait sends progress notifications while waiting');
  await user('Keys', { type: 'share', taskId: 't1', done: true, note: '' });
  r = await w2;
  check(/t1 Create key: DONE/.test(r.text), 'shared task also ends the wait');

  // ---------- closing from the sidebar or the Command Palette counts an answer the panel hasn't saved yet
  const E = chat('E');
  await E.tool('checklist_ask', { title: 'Closing', questions: [{ question: 'Which database?', options: ['Postgres', 'MySQL'] }] });
  await sleep(500);
  const closingId = (await panel('Closing')).id;
  W.send({ cmd: 'unsaved', title: 'Closing', msgs: [{ type: 'answerDraft', qid: 'q1', picks: ['o1'], other: '', note: '' }] }); await wwait('done');
  W.send({ cmd: 'command', name: 'checklistBridge.close', args: [closingId] });
  const asked = await wwait('warn');
  check(asked.warn === 'Close "Closing"?' && /^1 answer is still not shared\./.test(asked.detail), `the close warning counts it, not "not answered" (${asked.detail})`);
  await wwait('done');

  [A, B, C, D, E].forEach((c) => c.kill());
  W.send({ cmd: 'quit' });
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  setTimeout(() => process.exit(failed ? 1 : 0), 700);
})();
