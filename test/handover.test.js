const __ROOT = require('path').resolve(__dirname, '..');
// Switching between the extension and the mod: the mode file, the shared folder's names, handing checklists
// over and back, the mod's wording, and that mod/hooks/lib/ matches src/.
const path = require('path'), fs = require('fs');
const DIST = __ROOT + '/dist';
const { ChecklistStore, TOOLS, MOD_TOOLS, SERVER_INSTRUCTIONS, MOD_INSTRUCTIONS } = require(DIST + '/model.js');
const H = require(DIST + '/handover.js');
const { SHARED, expected } = require(__ROOT + '/scripts/copy-mod-lib.js');

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; };
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/* ---------- the mode file */
check(H.parseMode(H.modeText('mod')) === 'mod' && H.parseMode(H.modeText('extension')) === 'extension', 'mode file round-trips');
check(H.parseMode(undefined) === undefined && H.parseMode('{oops') === undefined && H.parseMode('{"use":"other"}') === undefined, 'a missing, broken or unknown mode file means no choice yet');

/* ---------- folder keys */
check(H.folderKey('C:\\Work\\My App') === H.folderKey('c:/work/my app/'), 'Windows paths: same key with either slash, any case, trailing slash');
check(H.folderKey('/home/a/proj') !== H.folderKey('/home/b/proj'), 'two folders with the same name get different keys');
check(/^my-app-[0-9a-f]{8}$/.test(H.folderKey('C:\\Work\\My App')), 'the key starts with the folder name: ' + H.folderKey('C:\\Work\\My App'));
check(/^folder-[0-9a-f]{8}$/.test(H.folderKey('/')) && !/[\\/:]/.test(H.folderKey('D:\\')), 'a root folder still gets a safe key');
check(H.join('/home/u/.checklist-bridge/', 'mod', 'x') === '/home/u/.checklist-bridge/mod/x' && H.join('C:\\Users\\u\\.cb', 'mode.json') === 'C:\\Users\\u\\.cb/mode.json', 'join');
check(JSON.stringify(H.listIds(['a1.json', 'a1.json.bak', 'b2.json.moved', 'b2.json.bak.moved', 'x.txt', '../evil.json'])) === '["a1"]', 'checklists are <id>.json files, each once; .moved and other files are not');
check(JSON.stringify(H.listIds(['c3.json.bak'])) === '["c3"]', 'a checklist whose first save stopped after its backup is still found');
check(H.folderKey('/Users/me/Projects/MyApp') === H.folderKey('/users/me/projects/myapp'), 'macOS: the same folder spelled with other capitals gets the same key');
check(H.absolutePath('~/Desktop/a.png', '/home/u', '/work/p') === '/home/u/Desktop/a.png', 'a ~ screenshot path is under the home folder');
check(H.absolutePath('shots/a.png', '/home/u', '/work/p') === '/work/p/shots/a.png' && H.absolutePath('./a.png', '/home/u', '/work/p') === '/work/p/a.png', 'a relative path is under the project folder');
check(H.absolutePath('"/tmp/my shot.png"', '/h', '/w') === '/tmp/my shot.png' && H.absolutePath('C:\\Users\\u\\a.png', '/h', '/w') === 'C:\\Users\\u\\a.png', 'an absolute path stays as it is, without the quotes');

/* ---------- hand over and back */
const ext = new ChecklistStore();
ext.handleTool('s1', { cwd: '/work/app' }, 'checklist_add_tasks', { title: 'Launch', tasks: [{ text: 'Create a key' }, { text: 'Set the env var' }] });
ext.handleTool('s1', { cwd: '/work/app' }, 'checklist_ask', { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] });
const c = ext.forSession('s1');
ext.setDraft(c.id, 't1', { done: true, note: 'made it' });
ext.addImages(c.id, 't1', [{ mime: 'image/png', data: 'aGVsbG8=', w: 2, h: 3 }]);
ext.share(c.id, 't1');
ext.setAnswerDraft(c.id, 'q1', { picks: [c.questions[0].options[0].id] });
ext.shareAnswer(c.id, 'q1');
const files = {};
const shared = H.toShared(c, (img) => { const p = `/cb/mod/images/${img.id}.png`; files[p] = img.data; return p; });
check(shared.tasks[0].shared.images.length === 1 && shared.tasks[0].shared.images[0].path && !shared.tasks[0].shared.images[0].data, 'screenshots become file paths in the shared copy');
check(c.tasks[0].shared.images[0].data === 'aGVsbG8=', 'the extension\'s own copy is not changed');
const parsed = H.parseList(JSON.stringify(shared));
check(parsed && parsed.id === c.id && parsed.tasks.map((t) => t.id).join() === 't1,t2' && parsed.questions[0].id === 'q1', 'ids are kept');
check(parsed.tasks[0].shared.note === 'made it' && parsed.tasks[0].shared.done && parsed.questions[0].answer.picks.length === 1, 'shared tasks and answers are kept');
check(H.parseList('{broken') === undefined && H.parseList('{"id":"x"}') === undefined, 'a broken file is not a checklist');

const mod = new ChecklistStore([parsed]);
mod.host = 'mod';
check(mod.forSession('s1')?.id === c.id, 'the mod has the checklist');
const r = text(mod.handleTool('s1', {}, 'checklist_read', { include_earlier_images: true }));
check(/screenshot 1\/1: \/cb\/mod\/images\/\w+\.png \(open it with your Read tool\)/.test(r), 'the mod tells Claude where a screenshot is');
check(!/VS Code|checklist_wait/.test(r), 'mod results don\'t mention VS Code or checklist_wait');
check(mod.addImagePath(c.id, 't2', '"/home/u/Desktop/shot 1.JPG"') && mod.get(c.id).tasks[1].draft.images[0].mime === 'image/jpeg', 'a screenshot path can be added in the mod');
check(!mod.addImagePath(c.id, 't2', '/home/u/notes.txt'), 'a path that is not an image is refused');

check(H.toShared({ ...c, hidden: true }, () => undefined).hidden === true, 'a checklist whose tab the user closed stays that way after the round trip');
const said = text(mod.handleTool('s3', {}, 'checklist_add_tasks', { title: 'Try it in VS Code', tasks: [{ text: 'Check it in VS Code' }] }));
check(said.includes('"Try it in VS Code"') && text(mod.handleTool('s3', {}, 'checklist_read', {})).includes('Check it in VS Code'), 'the mod leaves the user\'s own words alone');
check(!/VS Code/.test(said.replace('"Try it in VS Code"', '')), 'but drops ours');

const back = H.fromShared(mod.get(c.id), (p) => files[p]);
check(back.tasks[0].shared.images[0].data === 'aGVsbG8=', 'screenshots come back with their data');
check(back.tasks[1].draft.images.length === 0, 'a screenshot whose file is gone is left out');

/* ---------- read-only while the mod has the checklists */
const locked = new ChecklistStore();
locked.handleTool('s9', { cwd: '/w' }, 'checklist_add_tasks', { tasks: [{ text: 'One' }] });
locked.lockedNote = 'read-only here';
const lr = locked.handleTool('s9', {}, 'checklist_add_tasks', { tasks: [{ text: 'Two' }] });
check(text(lr) === 'read-only here' && locked.forSession('s9').tasks.length === 1, 'a locked store tells Claude why and changes nothing');
check(!locked.hasPending('s9'), 'and has nothing for checklist_wait to wait for');
locked.lockedNote = undefined;
check(locked.forSession('s9').tasks.length === 1 && !text(locked.handleTool('s9', {}, 'checklist_read', {})).includes('read-only'), 'unlocked, it works again');

/* ---------- the mod's wording */
check(!MOD_TOOLS.some((t) => t.name === 'checklist_wait') && MOD_TOOLS.length === TOOLS.length - 1, 'the mod has every tool but checklist_wait');
check(!JSON.stringify(MOD_TOOLS).includes('VS Code') && !JSON.stringify(MOD_TOOLS).includes('checklist_wait'), 'mod tool descriptions don\'t mention VS Code or checklist_wait');
check(!/VS Code|checklist_wait/.test(MOD_INSTRUCTIONS) && /Send now/.test(MOD_INSTRUCTIONS), 'mod instructions');
check(/in the user's VS Code/.test(SERVER_INSTRUCTIONS) && TOOLS.some((t) => t.name === 'checklist_wait'), 'the extension\'s tools and instructions are unchanged');
const asked = text(mod.handleTool('s2', {}, 'checklist_ask', { questions: [{ question: 'Name?', options: [{ label: 'A' }, { label: 'B' }] }] }));
check(/end your turn/.test(asked) && !/checklist_wait|VS Code/.test(asked), 'mod: asking says to end the turn, not to wait');

/* ---------- tidying the shared folders */
{
  const { tidyShared, KEEP_MS } = require(DIST + '/switcher.js');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cb-tidy-'));
  const imgs = H.imagesDir(root), dir = H.sharedDir(root, '/w/app');
  fs.mkdirSync(imgs, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const put = (p, text, ageMs) => {
    fs.writeFileSync(p, text);
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  };
  const OLD = KEEP_MS + 60_000;
  const used = path.join(imgs, 'used.png');
  const list = { id: 'a1', title: 'x', sessionId: 's', tasks: [{ id: 't1', text: 'x', draft: { done: false, note: '', images: [] }, shared: { at: 1, done: true, note: '', images: [{ id: 'i', mime: 'image/png', w: 0, h: 0, path: used }] } }], questions: [], updatedAt: 1 };
  put(path.join(dir, 'a1.json'), JSON.stringify(list), OLD);
  put(used, 'PNG', OLD);
  put(path.join(imgs, 'unused-old.png'), 'PNG', OLD);
  put(path.join(imgs, 'unused-new.png'), 'PNG', 0);
  put(path.join(dir, 'b2.json.moved'), '{}', OLD);
  put(path.join(dir, 'c3.json.moved'), '{}', 0);
  const n = tidyShared(root);
  const has = (p) => fs.existsSync(p);
  check(n === 2 && !has(path.join(imgs, 'unused-old.png')) && !has(path.join(dir, 'b2.json.moved')), 'tidy: deletes old .moved files and old screenshots no checklist uses');
  check(has(used) && has(path.join(imgs, 'unused-new.png')) && has(path.join(dir, 'c3.json.moved')) && has(path.join(dir, 'a1.json')), 'tidy: keeps screenshots in use, recent files and the checklists');
  fs.rmSync(root, { recursive: true, force: true });
}

/* ---------- the mod's copies */
for (const f of SHARED)
  check(fs.readFileSync(path.join(__ROOT, 'mod', 'hooks', 'lib', f), 'utf8').replace(/\r\n/g, '\n') === expected(f), `mod/hooks/lib/${f} matches src/${f} (run npm run build)`);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
