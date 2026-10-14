const __ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs'), path = require('path'), os = require('os');
const { applySetup, removeSetup, isSetUp, INSTRUCTIONS } = require(__ROOT + '/dist/claudeSetup.js');
let failed = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));

// 1. Fresh machine: no ~/.claude at all
let d = path.join(tmp(), '.claude');
let r = applySetup(d);
check(r.instructions === 'added' && r.permission === 'added' && isSetUp(d), 'fresh: creates CLAUDE.md block and permission');
check(JSON.parse(fs.readFileSync(d + '/settings.json')).permissions.allow.includes('mcp__checklist'), 'fresh: settings.json allows mcp__checklist');

// 2. Existing user content is preserved, setup is idempotent
d = tmp();
const mine = '# My rules\n- Use pnpm\n- British spelling\n';
fs.writeFileSync(d + '/CLAUDE.md', mine);
fs.writeFileSync(d + '/settings.json', JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)'], deny: ['Read(.env)'] } }, null, 2));
applySetup(d);
const md1 = fs.readFileSync(d + '/CLAUDE.md', 'utf8');
check(md1.startsWith(mine.trimEnd()) && md1.includes(INSTRUCTIONS), 'existing CLAUDE.md kept, block appended');
const s1 = JSON.parse(fs.readFileSync(d + '/settings.json'));
check(s1.model === 'opus' && s1.permissions.deny[0] === 'Read(.env)' && s1.permissions.allow.join() === 'Bash(npm test),mcp__checklist', 'existing settings kept, permission appended');
check(fs.existsSync(d + '/settings.json.before-checklist-bridge'), 'backup of settings.json written');
r = applySetup(d);
check(r.instructions === 'unchanged' && r.permission === 'unchanged' && fs.readFileSync(d + '/CLAUDE.md', 'utf8') === md1, 'running twice changes nothing');

// 3. An older block gets replaced in place, not duplicated
fs.writeFileSync(d + '/CLAUDE.md', md1.replace(INSTRUCTIONS, 'old text'));
r = applySetup(d);
const md2 = fs.readFileSync(d + '/CLAUDE.md', 'utf8');
check(r.instructions === 'updated' && md2.split('checklist-bridge:start').length === 2 && md2.includes(INSTRUCTIONS), 'older block updated in place');

// 4. Undo restores the user's own content exactly
r = removeSetup(d);
check(fs.readFileSync(d + '/CLAUDE.md', 'utf8') === mine, 'undo: CLAUDE.md back to the original');
check(JSON.parse(fs.readFileSync(d + '/settings.json')).permissions.allow.join() === 'Bash(npm test)', 'undo: permission removed, others kept');
check(!isSetUp(d), 'undo: reported as not set up');

// 5. settings.json with comments is never rewritten
d = tmp();
const jsonc = '{\n  // my settings\n  "model": "sonnet"\n}\n';
fs.writeFileSync(d + '/settings.json', jsonc);
r = applySetup(d);
check(r.permission === 'skipped' && /left untouched/.test(r.note) && fs.readFileSync(d + '/settings.json', 'utf8') === jsonc, 'settings with comments left untouched, user told');
check(r.instructions === 'added', '...but instructions still added');
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS'); process.exit(failed ? 1 : 0);
