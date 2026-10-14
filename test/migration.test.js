const __ROOT = require('path').resolve(__dirname, '..');
const { fork } = require('child_process'); const path = require('path'), fs = require('fs'), os = require('os');
process.env.CHECKLIST_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-'));
const w = fork(path.join(__dirname, 'harness', 'fakewin.js'), ['w', '/work/x', __ROOT, path.join(process.env.CHECKLIST_BRIDGE_HOME, 's'), '1'], { env: { ...process.env, HAS_OLD: '1' } });
let seen = '';
w.on('message', (m) => { if (m.log && /VSCODE|old copy|moved/.test(m.log)) seen += m.log + '\n'; if (m.ready) setTimeout(() => { console.log(seen.trim()); console.log(/uninstallExtension akshat\.checklist-bridge/.test(seen) ? 'PASS old copy uninstalled' : 'FAIL old copy not uninstalled'); process.exitCode = /uninstallExtension akshat\.checklist-bridge/.test(seen) ? 0 : 1; w.send({ cmd: 'quit' }); }, 400); });
