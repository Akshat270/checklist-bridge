// Connecting Claude Code without a terminal. Uses a fake `claude` command and a temporary home
// folder, so it never touches the real Claude Code setup on the machine running the tests.
const { fork } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'harness', 'fake-claude');
const C = require(ROOT + '/dist/claudeConnect.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

/** A sandbox: empty home, PATH with only node (and optionally the fake claude), no login shell. */
function sandbox({ withClaude = true, fail = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-home-'));
  const log = path.join(home, 'claude-calls.log');
  const nodeDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    PATH: [withClaude ? FAKE : null, nodeDir].filter(Boolean).join(path.delimiter),
    SHELL: '', FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_FAIL: fail ? '1' : '',
    CHECKLIST_BRIDGE_CLAUDE: withClaude ? '' : 'none',
  };
  delete env.Path;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const config = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', '.claude.json'), 'utf8')); } catch { return {}; } };
  return { home, env, calls, config };
}
// claudeConnect reads process.env by default; run each unit case with the sandbox's environment.
async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

(async () => {
  // ---- unit
  {
    const sb = sandbox();
    const connector = path.join(sb.home, 'dir with spaces', 'connector', 'connector.js');
    fs.mkdirSync(path.dirname(connector), { recursive: true }); fs.writeFileSync(connector, '');
    const found = await withEnv(sb.env, () => C.findClaude());
    check(found && found.startsWith(FAKE), `finds the claude command (${found && path.basename(found)})`);

    const r = await withEnv(sb.env, () => C.connect({ connectorPath: connector, electronPath: process.execPath }));
    const s = sb.config().mcpServers?.checklist;
    check(r.status === 'connected', 'connects without a terminal');
    check(s && s.args.includes(connector), 'registers the connector, even with spaces in its path');
    check(sb.calls()[0]?.[1] === 'remove' && sb.calls().some((c) => c[1] === 'add'), 'removes an older registration first, then adds');
    check(await withEnv(sb.env, () => C.registeredInConfig(connector)), 'sees that it is connected by reading the config');

    const again = await withEnv(sb.env, () => C.connect({ connectorPath: connector, electronPath: process.execPath }));
    check(again.status === 'connected', 'connecting again (e.g. after an update) works');

    check(!(await withEnv(sb.env, () => C.registeredInConfig(path.join(sb.home, 'other', 'connector.js')))), 'a registration for a different connector does not count');
    const e = C.addArgs('/x/connector.js', false, '/apps/Code');
    check(e.includes('ELECTRON_RUN_AS_NODE=1') && e.slice(-2).join(' ') === '/apps/Code /x/connector.js', "without Node.js it uses VS Code's own runtime");
  }
  {
    const sb = sandbox({ withClaude: false });
    const r = await withEnv(sb.env, () => C.connect({ connectorPath: path.join(sb.home, 'connector.js'), electronPath: process.execPath }));
    check(r.status === 'no-claude', 'reports when Claude Code is not installed');
    // Only Anthropic's VS Code extension is installed, which bundles its own `claude`.
    const ext = path.join(sb.home, 'extensions', 'anthropic.claude-code-2.0.0', 'resources', 'native-binary');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
    const found = await withEnv({ ...sb.env, CHECKLIST_BRIDGE_CLAUDE: '', PATH: sb.home }, () => C.findClaude(process.env, undefined, undefined, [path.join(sb.home, 'extensions', 'anthropic.claude-code-2.0.0')]));
    check(found && found.includes('native-binary'), "finds the claude bundled with Anthropic's VS Code extension");
  }
  {
    const sb = sandbox({ fail: true });
    const r = await withEnv(sb.env, () => C.connect({ connectorPath: path.join(sb.home, 'connector.js'), electronPath: process.execPath }));
    check(r.status === 'failed' && /something went wrong/.test(r.detail), 'reports why when claude refuses');
  }

  // ---- in the extension: install, open VS Code, and it's connected
  const win = (sb) => {
    const ST = path.join(sb.home, 'vscode-storage');
    const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['proj', '/work/proj', ROOT, ST, '1'], {
      env: { ...sb.env, CB_AUTOCONNECT: '1', CHECKLIST_BRIDGE_HOME: path.join(sb.home, '.checklist-bridge') },
    });
    W.msgs = []; W.on('message', (m) => W.msgs.push(m));
    W.exited = new Promise((r) => W.on('exit', r));
    W.ready = new Promise((r) => W.on('message', (m) => m.ready && r()));
    return W;
  };
  const notes = (W) => W.msgs.filter((m) => m.log && /NOTIFY|ERROR/.test(m.log)).map((m) => m.log.replace(/^.*?(NOTIFY|ERROR) /, ''));
  const contexts = (W) => W.msgs.filter((m) => m.context).map((m) => m.context['checklistBridge.connected']);
  {
    const sb = sandbox();
    let W = win(sb); await W.ready; await sleep(2500);
    const connector = path.join(sb.home, '.checklist-bridge', 'connector', 'connector.js');
    check(sb.config().mcpServers?.checklist?.args.includes(connector), 'first start: Claude Code is connected automatically, no terminal, no Enter');
    check(notes(W).some((n) => /connected to Claude Code/.test(n)), 'and the user is told in plain words');
    check(contexts(W).at(-1) === true, 'the sidebar knows it is connected');
    check(!W.msgs.some((m) => m.log && /TERMINAL/.test(m.log)), 'no terminal was opened');
    W.send({ cmd: 'quit' }); await W.exited;

    const before = sb.calls().length;
    W = win(sb); await W.ready; await sleep(1500);
    check(sb.calls().length === before, 'next start: already connected, nothing is run again');
    check(!notes(W).some((n) => /connected to Claude Code/.test(n)), 'and no repeated message');
    W.send({ cmd: 'quit' }); await W.exited;
  }
  {
    const sb = sandbox({ withClaude: false });
    const warned = (W) => W.msgs.some((m) => m.log && /WARN .*could not find it/.test(m.log));
    let W = win(sb); await W.ready; await sleep(2000);
    check(warned(W), 'without Claude Code installed, the user is told to install it');
    check(contexts(W).at(-1) === false, 'and the sidebar shows the Connect button');
    W.send({ cmd: 'quit' }); await W.exited;
    W = win(sb); await W.ready; await sleep(1500);
    check(!warned(W), 'the warning is not repeated on every start');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
