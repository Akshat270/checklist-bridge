// Switching between the extension and the Claude Code mod, in a fake VS Code window with a fake `claude`
// and a temporary home folder (never the real Claude Code setup). See src/switcher.ts and src/handover.ts.
const { fork } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'harness', 'fake-claude');
const { ChecklistStore } = require(ROOT + '/dist/model.js');
const { ImageFiles } = require(ROOT + '/dist/images.js');
const H = require(ROOT + '/dist/handover.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-home-'));
  const log = path.join(home, 'claude-calls.log');
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    PATH: [FAKE, path.dirname(process.execPath)].join(path.delimiter),
    SHELL: '', FAKE_CLAUDE_LOG: log, CHECKLIST_BRIDGE_TEST: '1', CHECKLIST_BRIDGE_CLAUDE: '',
    CHECKLIST_BRIDGE_HOME: path.join(home, '.checklist-bridge'), CB_AUTOCONNECT: '1',
  };
  delete env.Path;
  const cb = env.CHECKLIST_BRIDGE_HOME;
  const storage = path.join(home, 'vscode-storage');
  return {
    home, env, cb, storage,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    registered: () => { try { return !!JSON.parse(fs.readFileSync(path.join(home, '.claude', '.claude.json'), 'utf8')).mcpServers?.checklist; } catch { return false; } },
    mode: () => { try { return JSON.parse(fs.readFileSync(path.join(cb, 'mode.json'), 'utf8')).use; } catch { return undefined; } },
    shared: () => H.sharedDir(cb, '/work/proj'),
  };
}

function win(sb) {
  const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['proj', '/work/proj', ROOT, sb.storage, '1'], { env: sb.env });
  W.msgs = []; W.on('message', (m) => W.msgs.push(m));
  W.exited = new Promise((r) => W.on('exit', r));
  W.ready = new Promise((r) => W.on('message', (m) => m.ready && r()));
  return W;
}
const user = (W, title, msg) => { W.send({ cmd: 'user', title, msg }); return new Promise((r) => W.on('message', (m) => m.done && r())); };
const cmd = (W, name) => { W.send({ cmd: 'command', name }); return new Promise((r) => W.on('message', (m) => m.done && r())); };
const notes = (W) => W.msgs.filter((m) => m.log && /NOTIFY/.test(m.log)).map((m) => m.log.replace(/^.*?NOTIFY /, ''));
const modMode = (W) => W.msgs.filter((m) => m.context && 'checklistBridge.modMode' in m.context).map((m) => m.context['checklistBridge.modMode']).at(-1);

/** A checklist this window saved earlier: two tasks, t1 shared with a note and a screenshot. */
function seed(sb) {
  const dir = path.join(sb.storage, 'checklists');
  fs.mkdirSync(dir, { recursive: true });
  const s = new ChecklistStore();
  s.handleTool('chat-1', { cwd: '/work/proj' }, 'checklist_add_tasks', { title: 'Launch', tasks: [{ text: 'Create a key' }, { text: 'Set the env var' }] });
  const c = s.forSession('chat-1');
  s.setDraft(c.id, 't1', { done: true, note: 'made it' });
  s.addImages(c.id, 't1', [{ mime: 'image/png', data: PNG, w: 1, h: 1 }]);
  s.share(c.id, 't1');
  fs.writeFileSync(path.join(dir, `${c.id}.json`), new ImageFiles(path.join(dir, 'images')).serialize(c));
  return c.id;
}

(async () => {
  // ---- from the extension to the mod, with the command
  const sb = sandbox();
  const id = seed(sb);
  let W = win(sb); await W.ready; await sleep(2500);
  check(sb.registered(), 'starts connected as usual');
  check(sb.mode() === 'extension', 'and notes that the extension is the one in use');

  await cmd(W, 'checklistBridge.useMod'); await sleep(500);
  check(sb.mode() === 'mod', '"Use the Claude Code mod instead" switches');
  check(!sb.registered() && sb.calls().some((c) => c[1] === 'remove' && c[2] === 'checklist'), 'and disconnects Claude Code from the extension');
  check(modMode(W) === true, 'the sidebar shows that the mod is in use');
  check(notes(W).some((n) => n.includes('/plugin install checklist-bridge --marketplace Akshat270/checklist-bridge')), 'the user is told how to install the mod');
  const file = path.join(sb.shared(), `${id}.json`);
  const handed = fs.existsSync(file) && H.parseList(fs.readFileSync(file, 'utf8'));
  check(handed && handed.tasks.map((t) => t.id).join() === 't1,t2' && handed.tasks[0].shared.note === 'made it', 'the checklist is in the mod\'s folder, ids and shares kept');
  const shot = handed && handed.tasks[0].shared.images[0];
  check(shot && shot.path && fs.readFileSync(shot.path).toString('base64') === PNG, 'with its screenshot as an image file');
  W.send({ cmd: 'quit' }); await W.exited;

  const before = sb.calls().length;
  W = win(sb); await W.ready; await sleep(2000);
  check(sb.calls().length === before && !sb.registered(), 'next start: it does not connect again while the mod is in use');
  check(modMode(W) === true && !notes(W).length, 'and says nothing new');

  // ---- the mod hands it back: the user shared t2 there, then ran /checklist use-extension
  const c = H.parseList(fs.readFileSync(file, 'utf8'));
  c.tasks[1].shared = { at: Date.now(), done: true, note: 'set in the mod', images: [] };
  c.updatedAt = Date.now(); // the mod marks every change
  fs.writeFileSync(file, JSON.stringify(c));
  fs.writeFileSync(path.join(sb.cb, 'mode.json'), H.modeText('extension'));
  W.send({ cmd: 'focus' }); await sleep(2500);
  check(sb.registered(), 'back to the extension: Claude Code is connected again');
  check(modMode(W) === false, 'the sidebar is back to normal');
  check(fs.existsSync(`${file}.moved`) && !fs.existsSync(file), 'the mod\'s file is marked as moved, so it isn\'t taken in twice');
  check(notes(W).some((n) => /back in VS Code/.test(n)), 'the user is told the checklist is back');
  W.send({ cmd: 'quit' }); await W.exited;
  const saved = JSON.parse(fs.readFileSync(path.join(sb.storage, 'checklists', `${id}.json`), 'utf8'));
  check(saved.tasks[1].shared?.note === 'set in the mod', 'what the user did in the mod is kept');
  check(saved.tasks[0].shared?.images.length === 1 && saved.tasks[0].shared.images[0].stored, 'screenshots came back too');

  // ---- the mod is switched on from Claude Code (/checklist use-mod) while VS Code is open
  {
    const sb2 = sandbox();
    const id2 = seed(sb2);
    W = win(sb2); await W.ready; await sleep(2500);
    fs.writeFileSync(path.join(sb2.cb, 'mode.json'), H.modeText('mod'));
    W.send({ cmd: 'focus' }); await sleep(2000);
    check(!sb2.registered() && fs.existsSync(path.join(sb2.shared(), `${id2}.json`)), 'the window follows: it hands its checklists over and disconnects');
    check(notes(W).some((n) => /runs inside Claude Code now/.test(n)), 'and tells the user');
    await cmd(W, 'checklistBridge.connect'); await sleep(1500);
    check(sb2.mode() === 'extension' && sb2.registered(), 'Connect while the mod is in use switches back instead of connecting both');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  // ---- after handing over, the checklists are read-only in VS Code, so nothing done here can be lost
  {
    const sb4 = sandbox();
    const id4 = seed(sb4);
    W = win(sb4); await W.ready; await sleep(2500);
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'shared in VS Code' });
    check(notes(W).some((n) => /in the Claude Code mod now, so this one is read-only here/.test(n)), 'an edit in VS Code after handing over is refused, and the user is told why');
    fs.writeFileSync(path.join(sb4.cb, 'mode.json'), H.modeText('extension'));
    W.send({ cmd: 'focus' }); await sleep(2500);
    check(sb4.registered(), 'switched back while the window was open');
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'shared after coming back' });
    W.send({ cmd: 'quit' }); await W.exited;
    const kept = JSON.parse(fs.readFileSync(path.join(sb4.storage, 'checklists', `${id4}.json`), 'utf8'));
    check(kept.tasks[1].shared?.note === 'shared after coming back', 'once back, the checklist can be edited in VS Code again');
  }

  // ---- switching back while VS Code is closed: no "the connection was removed" question
  {
    const sb5 = sandbox();
    seed(sb5);
    W = win(sb5); await W.ready; await sleep(2500);
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    W.send({ cmd: 'quit' }); await W.exited;
    fs.writeFileSync(path.join(sb5.cb, 'mode.json'), H.modeText('extension'));
    W = win(sb5); await W.ready; await sleep(2500);
    check(sb5.registered() && !notes(W).some((n) => /no longer connected/.test(n)), 'next start after /checklist use-extension: reconnects without asking');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  // ---- the mod is in use, and the extension is installed but not connected: it leaves the mod's checklists alone
  {
    const sb6 = sandbox();
    sb6.env.CB_AUTOCONNECT = '0';
    const s = new ChecklistStore();
    s.handleTool('mod-chat', { cwd: '/work/proj' }, 'checklist_add_tasks', { title: 'Mod only', tasks: [{ text: 'One' }] });
    const mid = s.forSession('mod-chat').id;
    fs.mkdirSync(sb6.shared(), { recursive: true });
    fs.writeFileSync(path.join(sb6.shared(), `${mid}.json`), JSON.stringify(s.forSession('mod-chat')));
    W = win(sb6); await W.ready; await sleep(2500);
    check(fs.existsSync(path.join(sb6.shared(), `${mid}.json`)) && !sb6.registered(), 'with auto-connect off, the mod keeps its checklists and Claude Code is not connected');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  // ---- someone who only ever used the mod opens VS Code: the extension takes their checklists in
  {
    const sb3 = sandbox();
    const s = new ChecklistStore();
    s.handleTool('mod-chat', { cwd: '/work/proj' }, 'checklist_add_tasks', { title: 'From the mod', tasks: [{ text: 'One' }] });
    fs.mkdirSync(sb3.shared(), { recursive: true });
    fs.writeFileSync(path.join(sb3.shared(), `${s.forSession('mod-chat').id}.json`), JSON.stringify(s.forSession('mod-chat')));
    W = win(sb3); await W.ready; await sleep(3000);
    check(W.msgs.some((m) => m.panelOpened === 'From the mod'), 'a checklist made in the mod opens in VS Code');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
