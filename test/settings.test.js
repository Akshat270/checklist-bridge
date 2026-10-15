// A project's .vscode/settings.json must not be able to point the updater at another repo or make the
// extension run a program of its choosing. Only the user's own settings may change those.
const { fork } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

const declared = require(ROOT + '/package.json').contributes.configuration.properties;
for (const k of ['checklistBridge.updateRepo', 'checklistBridge.autoUpdate', 'checklistBridge.claudePath', 'checklistBridge.autoConnect'])
  check(['application', 'machine'].includes(declared[k]?.scope), `${k} can only be set in the user's own settings (scope: ${declared[k]?.scope ?? 'none'})`);

async function attempt(ignoreScopes) {
  const label = ignoreScopes ? ' (even if VS Code ignored the setting scopes)' : '';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-home-'));
  // A "claude" planted in a cloned repo: it leaves a marker if it ever runs.
  const marker = path.join(home, 'EVIL-RAN');
  const evil = path.join(home, 'repo', process.platform === 'win32' ? 'evil.cmd' : 'evil');
  fs.mkdirSync(path.dirname(evil), { recursive: true });
  fs.writeFileSync(evil, process.platform === 'win32' ? `@echo ran > "${marker}"\r\n` : `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });

  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), SHELL: '',
    PATH: [path.join(__dirname, 'harness', 'fake-claude'), path.dirname(process.execPath)].join(path.delimiter),
    CHECKLIST_BRIDGE_HOME: path.join(home, '.cb'), CHECKLIST_BRIDGE_CLAUDE: '',
    CB_AUTOCONNECT: '1',
    CB_WS_SETTINGS: JSON.stringify({ claudePath: evil, updateRepo: 'attacker/evil-fork', autoUpdate: true }),
    CB_IGNORE_SCOPES: ignoreScopes ? '1' : '',
  };
  const W = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['repo', path.join(home, 'repo'), ROOT, path.join(home, 'st'), '1'], { env });
  const logs = []; W.on('message', (m) => m.log && logs.push(m.log));
  await new Promise((r) => W.on('message', (m) => m.ready && r()));
  await sleep(2500);
  W.send({ cmd: 'command', name: 'checklistBridge.checkForUpdates' });
  await sleep(1500);

  check(!fs.existsSync(marker), "a program named in a project's settings is never run" + label);
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.claude.json'), 'utf8')); } catch {}
  check(!!cfg.mcpServers?.checklist, 'Claude Code is still connected, using the real claude command' + label);
  const repoLine = logs.find((l) => /Checking for updates from/.test(l)) || '';
  check(/Akshat270\/checklist-bridge/.test(repoLine) && !/attacker/.test(logs.join('\n')), `updates still come from the official repo${label} (${repoLine.replace(/^.*from /, '') || 'no check logged'})`);

  W.send({ cmd: 'quit' });
  await new Promise((r) => W.on('exit', r));
}

(async () => {
  await attempt(false);
  await attempt(true);
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
