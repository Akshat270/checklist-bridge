// The test-only environment hooks must do nothing in normal use (without CHECKLIST_BRIDGE_TEST=1).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
(async () => {
  const C = require(ROOT + '/dist/claudeConnect.js');
  const env = { PATH: '', HOME: '/nonexistent', SHELL: '', CHECKLIST_BRIDGE_CLAUDE: '/tmp/some-program' };
  check((await C.findClaude(env, async () => ({ ok: false, out: '' }))) === undefined, 'CHECKLIST_BRIDGE_CLAUDE is ignored outside the test suite');
  check((await C.findClaude({ ...env, CHECKLIST_BRIDGE_TEST: '1' }, async () => ({ ok: false, out: '' }))) === '/tmp/some-program', 'and works inside it');
  const src = require('fs').readFileSync(ROOT + '/dist/updater.js', 'utf8');
  check(/CHECKLIST_BRIDGE_TEST === '1' \? process\.env\.CHECKLIST_BRIDGE_UPDATE_BASE/.test(src), 'CHECKLIST_BRIDGE_UPDATE_BASE only applies inside the test suite');
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
