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
    const connector = path.join(sb.home, 'dir with spaces & 100%done', 'connector', 'connector.js');
    fs.mkdirSync(path.dirname(connector), { recursive: true }); fs.writeFileSync(connector, '');
    const found = await withEnv(sb.env, () => C.findClaude());
    check(found && found.startsWith(FAKE), `finds the claude command (${found && path.basename(found)})`);

    const r = await withEnv(sb.env, () => C.connect({ connectorPath: connector, electronPath: process.execPath }));
    const s = sb.config().mcpServers?.checklist;
    check(r.status === 'connected', 'connects without a terminal');
    check(s && s.args.includes(connector), 'registers the connector, even with spaces, & and % in its path');
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

  // ---- what the user decided sticks
  const cmd = (W, name) => { W.send({ cmd: 'command', name }); return new Promise((r) => W.on('message', (m) => m.done && r())); };
  const registered = (sb) => sb.config().mcpServers?.checklist;
  {
    const sb = sandbox();
    let W = win(sb); await W.ready; await sleep(2500);
    const reg = registered(sb);
    check(reg && path.isAbsolute(reg.command) && fs.existsSync(reg.command), `registers the full path of the runtime, not just "node" (${reg && reg.command})`);
    await cmd(W, 'checklistBridge.disconnect');
    check(!registered(sb), 'Disconnect removes the connection');
    W.send({ cmd: 'quit' }); await W.exited;
    W = win(sb); await W.ready; await sleep(2500);
    check(!registered(sb), 'after Disconnect, restarting VS Code does not reconnect by itself');
    check(contexts(W).at(-1) === false, 'and the sidebar offers Connect');
    await cmd(W, 'checklistBridge.connect'); await sleep(500);
    check(!!registered(sb), 'clicking Connect connects again');
    W.send({ cmd: 'quit' }); await W.exited;
  }
  {
    // Connected, then removed outside VS Code (e.g. `claude mcp remove checklist`).
    const sb = sandbox();
    let W = win(sb); await W.ready; await sleep(2500);
    W.send({ cmd: 'quit' }); await W.exited;
    const c = JSON.parse(fs.readFileSync(path.join(sb.home, '.claude', '.claude.json'), 'utf8')); delete c.mcpServers.checklist;
    fs.writeFileSync(path.join(sb.home, '.claude', '.claude.json'), JSON.stringify(c));
    W = win(sb); await W.ready; await sleep(2500);
    check(!registered(sb), 'a connection removed outside VS Code is not silently re-added');
    check(notes(W).some((n) => /no longer connected/.test(n)), 'the user is asked whether to reconnect instead');
    W.send({ cmd: 'quit' }); await W.exited;
    W = win(sb); await W.ready; await sleep(2000);
    check(!notes(W).some((n) => /no longer connected/.test(n)) && !registered(sb), 'and is asked only once');
    W.send({ cmd: 'quit' }); await W.exited;
  }
  {
    // The runtime the connection points to was removed (Node upgraded or uninstalled): repaired silently.
    const sb = sandbox();
    let W = win(sb); await W.ready; await sleep(2500);
    W.send({ cmd: 'quit' }); await W.exited;
    const f = path.join(sb.home, '.claude', '.claude.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    c.mcpServers.checklist.command = path.join(sb.home, 'old-node', 'v18', 'node'); fs.writeFileSync(f, JSON.stringify(c));
    W = win(sb); await W.ready; await sleep(2500);
    const reg = registered(sb);
    check(reg && fs.existsSync(reg.command), 'a connection pointing at a runtime that no longer exists is repaired by itself');
    W.send({ cmd: 'quit' }); await W.exited;
  }
  {
    // Getting started: "Start a new Claude chat" is ticked by Claude's checklist, not by the example.
    const sb = sandbox();
    const W = win(sb); await W.ready; await sleep(1500);
    const used = () => W.msgs.filter((m) => m.context && 'checklistBridge.claudeUsed' in m.context).map((m) => m.context['checklistBridge.claudeUsed']);
    await cmd(W, 'checklistBridge.demo'); await sleep(300);
    check(!used().includes(true), 'opening the example does not tick "Start a new Claude chat"');
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [path.join(__dirname, 'harness', 'fakeclaude.js'), path.join(sb.home, '.checklist-bridge', 'connector', 'connector.js')], { env: { ...sb.env, CHECKLIST_BRIDGE_HOME: path.join(sb.home, '.checklist-bridge'), CHECKLIST_BRIDGE_WINDOW: W.msgs.find((m) => m.windowId)?.windowId }, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'checklist_add_tasks', arguments: { title: 'Real', tasks: ['x'] } } });
    await new Promise((r) => { let b = ''; p.stdout.on('data', (d) => { b += d; if (b.includes('"id":2')) r(); }); });
    p.kill(); await sleep(300);
    check(used().includes(true), 'a checklist from Claude ticks it');
    W.send({ cmd: 'quit' }); await W.exited;
  }

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
