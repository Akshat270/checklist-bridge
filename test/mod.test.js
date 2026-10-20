// The Claude Code mod (mod/): `claude plugin validate` and the mod's own tests (`claude plugin test`,
// mod/hooks/*.test.tsx). Needs a `claude` new enough to have mods; skipped otherwise.
// Runs in a throwaway home folder, so the real Claude Code setup is never touched.
const path = require('path'), fs = require('fs'), os = require('os');
const C = require(path.resolve(__dirname, '..', 'dist', 'claudeConnect.js'));
const MOD = path.resolve(__dirname, '..', 'mod');
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

(async () => {
  const claude = C.findOnPath('claude');
  if (!claude) { console.log('SKIP no claude command installed'); process.exit(0); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbmod-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CHECKLIST_BRIDGE_HOME: path.join(home, '.checklist-bridge') };
  const help = await C.run(claude, ['plugin', 'test', '--help'], 60_000, env);
  if (!help.ok) { console.log('SKIP this claude has no `plugin test` (mods need a newer Claude Code)'); process.exit(0); }

  const v = await C.run(claude, ['plugin', 'validate', MOD], 120_000, env);
  check(v.ok && /Validation passed/.test(v.out), 'claude plugin validate mod');
  if (!v.ok) console.log(v.out);

  const t = await C.run(claude, ['plugin', 'test', MOD], 300_000, env);
  const out = t.out;
  for (const m of out.matchAll(/^\((pass|fail)\) (.+?) \[/gm)) check(m[1] === 'pass', `mod: ${m[2]}`);
  check(t.ok && /\b0 fail\b/.test(out) && /\(pass\)/.test(out), 'claude plugin test mod');
  if (!t.ok) console.log(out);
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
