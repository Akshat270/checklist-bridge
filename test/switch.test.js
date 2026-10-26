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

function win(sb, folder = '/work/proj') {
  const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), [path.basename(folder), folder, ROOT, sb.storage, '1'], { env: sb.env });
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
  {
    // The copy Claude Code runs has every file it needs (it only has what the extension copies there).
    const r = require('child_process').spawnSync(process.execPath, [path.join(sb.cb, 'connector', 'connector.js')], { env: sb.env, input: '', timeout: 10_000, encoding: 'utf8' });
    check(!/Cannot find module/.test(r.stderr), `the installed connector starts${r.stderr ? ': ' + r.stderr.split('\n')[0] : ''}`);
  }

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
    const lastState = () => W.msgs.filter((m) => m.state && m.title === 'Launch').at(-1)?.state;
    check(/Claude Code mod/.test(lastState()?.locked || ''), 'the panel shows it is read-only, with a way to switch back');
    const before = notes(W).length;
    await user(W, 'Launch', { type: 'share', taskId: 't1', done: true, note: 'again' });
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'and again' });
    check(notes(W).length === before, 'more edits while read-only do not pop up the same message again');
    W.send({ cmd: 'command', name: 'checklistBridge.close', args: [id4] }); await sleep(300);
    check(!W.msgs.some((m) => m.warn && /^Close /.test(m.warn)) && notes(W).some((n) => /Switch back to VS Code to close it/.test(n)), 'closing a read-only checklist is refused, not asked about');
    fs.writeFileSync(path.join(sb4.cb, 'mode.json'), H.modeText('extension'));
    W.send({ cmd: 'focus' }); await sleep(2500);
    check(sb4.registered(), 'switched back while the window was open');
    check(!lastState()?.locked, 'and the panel can be used again');
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'shared after coming back' });
    W.send({ cmd: 'quit' }); await W.exited;
    const kept = JSON.parse(fs.readFileSync(path.join(sb4.storage, 'checklists', `${id4}.json`), 'utf8'));
    check(kept.tasks[1].shared?.note === 'shared after coming back', 'once back, the checklist can be edited in VS Code again');
    check(!kept.closed, 'and the refused close did not close it');
  }

  // ---- a window with no folder open keeps its checklists: the mod works per folder, so it has nowhere to put them
  {
    const sb7 = sandbox();
    sb7.env.CB_FOLDERLESS = '1';
    seed(sb7);
    W = win(sb7); await W.ready; await sleep(2500);
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    check(notes(W).some((n) => /no folder open, so its checklists stay here/.test(n)), 'a window with no folder open says its checklists stay in VS Code');
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'still editable' });
    check(!notes(W).some((n) => /read-only/.test(n)) && !W.msgs.some((m) => m.state?.locked), 'and they are not made read-only');
    W.send({ cmd: 'quit' }); await W.exited;
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

  // ---- switched in this window's own terminal: the window never loses focus, so it follows the mode file
  {
    const sb8 = sandbox();
    const id8 = seed(sb8);
    W = win(sb8); await W.ready; await sleep(2500);
    fs.writeFileSync(path.join(sb8.cb, 'mode.json'), H.modeText('mod'));
    await sleep(3500);
    check(!sb8.registered() && fs.existsSync(path.join(sb8.shared(), `${id8}.json`)), 'switched to the mod without leaving VS Code: the window still hands its checklists over');
    fs.writeFileSync(path.join(sb8.cb, 'mode.json'), H.modeText('extension'));
    await sleep(3500);
    check(sb8.registered() && fs.existsSync(path.join(sb8.shared(), `${id8}.json.moved`)), 'and takes them back after /checklist use-extension, without a focus change');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  // ---- the mod's work is never overwritten, closing there closes here, and nothing comes back twice
  {
    const sb9 = sandbox();
    const id9 = seed(sb9);
    const shared = path.join(sb9.shared(), `${id9}.json`);
    const inMod = (change) => {
      const c = H.parseList(fs.readFileSync(shared, 'utf8'));
      change(c);
      c.updatedAt = Date.now();
      fs.writeFileSync(shared, JSON.stringify(c));
      fs.writeFileSync(`${shared}.bak`, JSON.stringify(c));
    };
    const stored = () => JSON.parse(fs.readFileSync(path.join(sb9.storage, 'checklists', `${id9}.json`), 'utf8'));
    W = win(sb9); await W.ready; await sleep(2500);
    W.send({ cmd: 'closeTab', title: 'Launch' }); await sleep(300); // the user closed its tab
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    const states = () => W.msgs.filter((m) => m.state && m.title === 'Launch').length;
    const st = states();
    for (let i = 0; i < 3; i++) W.send({ cmd: 'focus' });
    await sleep(800);
    check(states() === st, 'while the mod is on, focusing the window does not redraw its tabs again');

    inMod((c) => (c.tasks[1].shared = { at: Date.now(), done: true, note: 'done in the mod', images: [] }));
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    check(H.parseList(fs.readFileSync(shared, 'utf8')).tasks[1].shared?.note === 'done in the mod', 'running "Use the Claude Code mod" again does not write VS Code\'s older copy over the mod\'s');
    check(notes(W).some((n) => /already runs inside Claude Code/.test(n)), 'and says the mod is already in use');

    // Windows has the file open, so it can't be marked as moved: it is taken in once, not again over later edits.
    fs.mkdirSync(path.join(`${shared}.moved`, 'busy'), { recursive: true });
    const opened = W.msgs.filter((m) => m.panelOpened === 'Launch').length;
    fs.writeFileSync(path.join(sb9.cb, 'mode.json'), H.modeText('extension'));
    await sleep(3500);
    const lastState = W.msgs.filter((m) => m.state && m.title === 'Launch').at(-1)?.state;
    check(fs.existsSync(shared) && lastState?.list?.tasks?.[1]?.shared?.note === 'done in the mod', 'back in VS Code: what was done in the mod is there');
    check(W.msgs.filter((m) => m.panelOpened === 'Launch').length === opened + 1, 'its tab opens, as the mod changed it');
    await user(W, 'Launch', { type: 'unshare', taskId: 't2' });
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'changed in VS Code' });
    W.send({ cmd: 'focus' }); await sleep(1500);
    W.send({ cmd: 'quit' }); await W.exited;
    check(stored().tasks[1].shared?.note === 'changed in VS Code', 'a file that could not be marked as moved is not taken in again over later edits');

    // Closed in the mod: closed in VS Code too.
    fs.rmSync(`${shared}.moved`, { recursive: true, force: true });
    W = win(sb9); await W.ready; await sleep(2500);
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    inMod((c) => (c.closed = true));
    fs.writeFileSync(path.join(sb9.cb, 'mode.json'), H.modeText('extension'));
    await sleep(3500);
    W.send({ cmd: 'quit' }); await W.exited;
    check(stored().closed === true, 'a checklist closed in the mod is closed in VS Code too');
  }

  // ---- a checklist that could not be handed over stays usable in VS Code
  {
    const sb10 = sandbox();
    const id10 = seed(sb10);
    W = win(sb10); await W.ready; await sleep(2500);
    fs.mkdirSync(path.join(sb10.shared(), `${id10}.json.bak`, 'x'), { recursive: true }); // can't be written
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    check(W.msgs.some((m) => m.warn && /could not move "Launch".*you can still use it here/.test(m.warn)), 'the user is told it stays in VS Code');
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'still works' });
    check(!notes(W).some((n) => /read-only/.test(n)) && !W.msgs.some((m) => m.state?.locked), 'and it is not read-only');
    W.send({ cmd: 'quit' }); await W.exited;
    const kept = JSON.parse(fs.readFileSync(path.join(sb10.storage, 'checklists', `${id10}.json`), 'utf8'));
    check(kept.tasks[1].shared?.note === 'still works', 'what the user does there is saved');
  }

  // ---- after switching to the mod and back, a window for another folder reconnects without asking
  {
    const sb11 = sandbox();
    W = win(sb11); await W.ready; await sleep(2500);
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    W.send({ cmd: 'quit' }); await W.exited;
    fs.writeFileSync(path.join(sb11.cb, 'mode.json'), H.modeText('extension'));
    W = win(sb11, '/work/other'); await W.ready; await sleep(2500);
    check(sb11.registered() && !notes(W).some((n) => /no longer connected/.test(n)), 'another folder\'s window, after /checklist use-extension: connects without asking');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  // ---- while the mod has the checklists: the example still opens, and a close confirmed after the handover is refused
  {
    const sb12 = sandbox();
    sb12.env.CB_DIALOG_MS = '3000';
    const id12 = seed(sb12);
    W = win(sb12); await W.ready; await sleep(2500);
    W.send({ cmd: 'command', name: 'checklistBridge.close', args: [id12] }); // the user reads the question...
    await sleep(300);
    fs.writeFileSync(path.join(sb12.cb, 'mode.json'), H.modeText('mod')); // ...while the switch to the mod happens
    await sleep(4000);
    check(notes(W).some((n) => /Switch back to VS Code to close it/.test(n)), 'a close confirmed after the checklist was handed over is refused');
    await cmd(W, 'checklistBridge.demo'); await sleep(500);
    check(W.msgs.some((m) => m.panelOpened && m.panelOpened !== 'Launch'), 'the example checklist still opens while the mod has the checklists');
    W.send({ cmd: 'quit' }); await W.exited;
    check(!JSON.parse(fs.readFileSync(path.join(sb12.storage, 'checklists', `${id12}.json`), 'utf8')).closed, 'and the handed-over checklist stays open');
  }

  // ---- switched to the mod and straight back while the handover still runs: the window ends up as the mode file says
  {
    const sb13 = sandbox();
    sb13.env.FAKE_CLAUDE_REMOVE_MS = '4000'; // disconnecting takes a while, so the handover is still running
    seed(sb13);
    W = win(sb13); await W.ready;
    for (let i = 0; i < 40 && !sb13.registered(); i++) await sleep(250); // connected, so the handover has to disconnect
    fs.writeFileSync(path.join(sb13.cb, 'mode.json'), H.modeText('mod'));
    W.send({ cmd: 'focus' }); // the handover starts...
    await sleep(1000);
    fs.writeFileSync(path.join(sb13.cb, 'mode.json'), H.modeText('extension')); // ...and the user switches back meanwhile
    W.send({ cmd: 'focus' });
    await sleep(8000);
    check(sb13.registered() && modMode(W) === false, 'a switch back made during a handover is not lost');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  // ---- switched back to VS Code in Claude while the "Use the Claude Code mod" command still runs
  {
    const sb16 = sandbox();
    sb16.env.FAKE_CLAUDE_REMOVE_MS = '4000';
    seed(sb16);
    W = win(sb16); await W.ready;
    for (let i = 0; i < 40 && !sb16.registered(); i++) await sleep(250);
    const running = cmd(W, 'checklistBridge.useMod'); // disconnecting takes a while
    await sleep(1500);
    fs.writeFileSync(path.join(sb16.cb, 'mode.json'), H.modeText('extension')); // /checklist use-extension
    await running; await sleep(6000);
    check(sb16.registered() && modMode(W) === false, 'a switch back made while a switch command runs is not lost');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  // ---- a mod chat saving late, after VS Code took the checklist back: the user's later edits in VS Code stay
  {
    const sb14 = sandbox();
    const id14 = seed(sb14);
    W = win(sb14); await W.ready; await sleep(2500);
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    const shared = path.join(sb14.shared(), `${id14}.json`);
    const stale = fs.readFileSync(shared, 'utf8');
    fs.writeFileSync(path.join(sb14.cb, 'mode.json'), H.modeText('extension'));
    await sleep(3500);
    await user(W, 'Launch', { type: 'share', taskId: 't2', done: true, note: 'edited in VS Code' });
    fs.writeFileSync(shared, stale); // the late save
    W.send({ cmd: 'focus' }); await sleep(1500);
    W.send({ cmd: 'quit' }); await W.exited;
    const kept = JSON.parse(fs.readFileSync(path.join(sb14.storage, 'checklists', `${id14}.json`), 'utf8'));
    check(kept.tasks[1].shared?.note === 'edited in VS Code', 'an older copy saved late in the mod does not undo edits made in VS Code');
  }

  // ---- auto-connect off: coming back from the mod connects only if switching to the mod disconnected it
  {
    const sb15 = sandbox();
    sb15.env.CB_AUTOCONNECT = '0';
    seed(sb15);
    W = win(sb15); await W.ready; await sleep(2500);
    check(!sb15.registered(), 'auto-connect off: not connected at start');
    await cmd(W, 'checklistBridge.useMod'); await sleep(500);
    await cmd(W, 'checklistBridge.useExtension'); await sleep(1500);
    check(!sb15.registered(), 'and not connected after switching to the mod and back, as the user never connected it');
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
