// Runs every test suite against the compiled extension in dist/. Usage: npm test  (or node test/run.js [name...])
// The suites drive the real extension inside a stand-in VS Code window (test/harness/fakewin.js) and talk to it
// through the real connector, the way Claude Code does. UI suites need Playwright and skip without it.
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');

const only = process.argv.slice(2);
const suites = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !only.length || only.some((o) => f.startsWith(o)))
  .sort();

if (!fs.existsSync(path.join(__dirname, '..', 'dist', 'extension.js'))) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

const results = [];
for (const f of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 300_000, env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = (out.match(/^PASS /gm) || []).length;
  const fail = (out.match(/^FAIL /gm) || []).length;
  const skipped = /^SKIP /m.test(out);
  const ok = r.status === 0 && !fail;
  results.push({ f, ok, pass, fail, skipped, ms: Date.now() - t0 });
  const label = skipped ? 'SKIP' : ok ? ' OK ' : 'FAIL';
  console.log(`[${label}] ${f.padEnd(22)} ${String(pass).padStart(3)} passed${fail ? `, ${fail} failed` : ''}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (!ok && !skipped && process.env.GITHUB_ACTIONS) {
    // Shows up as an annotation on the run, readable without downloading logs.
    const lines = out.split('\n').filter((l) => /^FAIL |Error|at /.test(l)).slice(0, 12).join(' | ');
    console.log(`::error title=${f} failed::${(lines || out.slice(-800)).replace(/\r?\n/g, ' | ').replace(/%/g, '%25')}`);
  }
  if (!ok && !skipped) {
    console.log(out.split('\n').filter((l) => !/^PASS /.test(l)).map((l) => '    ' + l).join('\n'));
    if (r.error) console.log('    ' + r.error.message);
  }
}
const bad = results.filter((r) => !r.ok && !r.skipped);
const total = results.reduce((n, r) => n + r.pass, 0);
console.log(`\n${bad.length ? `${bad.length} suite(s) failed` : 'All suites passed'}: ${total} checks across ${results.length} suites.`);
process.exit(bad.length ? 1 : 0);
