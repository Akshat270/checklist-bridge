// Optional: checks the connection against the REAL `claude` command, if one is installed.
// Runs in a throwaway home folder, so the real Claude Code setup is never touched. Skipped otherwise.
const path = require('path'), fs = require('fs'), os = require('os');
const C = require(path.resolve(__dirname, '..', 'dist', 'claudeConnect.js'));
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

(async () => {
  const claude = C.findOnPath('claude');
  if (!claude) { console.log('SKIP no real claude command installed'); process.exit(0); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbreal-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' };
  delete env.CLAUDE_CONFIG_DIR;
  const connector = path.join(home, 'with space', 'connector', 'connector.js');
  fs.mkdirSync(path.dirname(connector), { recursive: true }); fs.writeFileSync(connector, '');

  const r = await C.connect({ connectorPath: connector, electronPath: process.execPath, claude, env });
  check(r.status === 'connected', `real claude: connect succeeds (${r.status}${r.detail ? ': ' + r.detail : ''})`);
  check(C.registeredInConfig(connector, env), 'real claude writes the connection where the extension looks (~/.claude.json)');
  const reg = C.registration(env);
  check(reg && path.isAbsolute(reg.command), `real claude records the full runtime path (${reg && reg.command})`);

  const cfgDir = path.join(home, 'cfg');
  const env2 = { ...env, CLAUDE_CONFIG_DIR: cfgDir };
  const r2 = await C.connect({ connectorPath: connector, electronPath: process.execPath, claude, env: env2 });
  check(r2.status === 'connected' && fs.existsSync(path.join(cfgDir, '.claude.json')), 'with CLAUDE_CONFIG_DIR set, it uses that folder, as the extension expects');

  await C.disconnect(claude, C.run, env2);
  await C.disconnect(claude, C.run, env);
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
