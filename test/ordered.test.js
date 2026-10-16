// Steps that must be done in order: Claude marks a group as ordered; tags never move a later step up.
const __ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const { ChecklistStore, normalize } = require(__ROOT + '/dist/model.js');
let failed = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

function build() {
  const s = new ChecklistStore(), S = 'x';
  s.handleTool(S, {}, 'checklist_add_tasks', {
    title: 'Deploy',
    ordered_groups: ['Release'],
    tasks: [
      { text: 'Build the app', group: 'Release' },
      { text: 'Upload the build', group: 'Release' },
      { text: 'Announce the release', group: 'Release', tags: ['important'] },
      { text: 'Check the logs', tags: ['important'] },
      { text: 'Tidy the docs' },
      { text: 'Rotate the keys', tags: ['important'] },
    ],
  });
  return { s, S, id: s.all()[0].id };
}

(async () => {
  const { s, S, id } = build();
  const c = s.get(id);
  check(c.orderedGroups.join() === 'Release' && c.groupOrder.includes('Release'), 'add_tasks marks the group as ordered');
  let t = text(await s.handleTool(S, {}, 'checklist_read', {}));
  check(/Release \(to be done in this order\):/.test(t), 'checklist_read tells Claude the group is a sequence');

  await s.handleTool(S, {}, 'checklist_edit', { unordered_groups: ['Release'] });
  check(c.orderedGroups.length === 0, 'unordered_groups clears it');
  await s.handleTool(S, {}, 'checklist_edit', { ordered_groups: ['Release', 'Nothing'] });
  check(c.orderedGroups.join() === 'Release', 'edit can mark a group as ordered; a group without tasks is ignored');
  await s.handleTool(S, {}, 'checklist_edit', { remove: ['t1', 't2', 't3'] });
  check(c.orderedGroups.length === 0, 'an ordered group with no tasks left is forgotten');

  // Findings from review: nothing is left behind by a name no task uses; moving a task and conflicting lists are explained.
  let r = await s.handleTool(S, {}, 'checklist_add_tasks', { ordered_groups: ['Typo '], tasks: [{ text: 'x', group: 'Other' }] });
  check(!c.orderedGroups.includes('Typo ') && !c.groupOrder.includes('Typo ') && /exactly this name/.test(text(r)), 'a name no task uses is not kept, and Claude is told');
  await s.handleTool(S, {}, 'checklist_add_tasks', { ordered_groups: ['Run'], tasks: [{ text: 'first', group: 'Run' }, { text: 'second', group: 'Run' }] });
  r = text(await s.handleTool(S, {}, 'checklist_read', {}));
  check(/\(step 1 of 2\) first/.test(r) && /\(step 2 of 2\) second/.test(r), 'checklist_read shows step numbers for an ordered group');
  const early = c.tasks.find((x) => x.text === 'x').id;
  r = text(await s.handleTool(S, {}, 'checklist_edit', { updates: [{ id: early, group: 'Run' }] }));
  check(/is now step 1 of 3 in "Run"/.test(r), 'moving a task into an ordered group says where it landed');
  r = text(await s.handleTool(S, {}, 'checklist_edit', { ordered_groups: ['Run'], unordered_groups: ['Run'] }));
  check(c.orderedGroups.includes('Run') && /both/.test(r), 'a group in both lists stays ordered, with a note');

  const old = JSON.parse(JSON.stringify(build().s.get(id) || c)); delete old.orderedGroups;
  check(normalize(old).orderedGroups.length === 0, 'a checklist saved before this change still loads');

  // The panel.
  const pw = require('./harness/playwright');
  if (!pw) { console.log('SKIP Playwright is not installed (panel checks)'); console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0); }
  const THEME = require('./harness/themes').dark;
  const css = fs.readFileSync(__ROOT + '/media/panel.css', 'utf8'), js = fs.readFileSync(__ROOT + '/media/panel.js', 'utf8');
  const b = await pw.chromium.launch();
  async function open(list) {
    const page = await b.newPage({ viewport: { width: 400, height: 1100 } });
    await page.setContent(`<!doctype html><html><head><style>html{${THEME}}${css}</style></head><body class="vscode-dark"><script>window.acquireVsCodeApi=()=>({postMessage(){},getState:()=>null,setState(){}});</script><script>${js}</script></body></html>`);
    await page.evaluate((l) => window.postMessage({ type: 'state', list: l, routes: { waiting: false, channel: false, terminal: false } }, '*'), list);
    await page.waitForTimeout(300);
    return page;
  }
  const ids = (page) => page.$$eval('.task', (xs) => xs.map((x) => x.dataset.id).join(' '));
  const next = (page) => page.$eval('[aria-label="Next task"] .task', (x) => x.dataset.id).catch(() => null);

  let list = JSON.parse(JSON.stringify(build().s.all()[0]));
  let page = await open(list);
  check((await next(page)) === 't4', 'an important task that can be done in any order is still the next task');
  const order = await ids(page);
  check(order.indexOf('t1') < order.indexOf('t2') && order.indexOf('t2') < order.indexOf('t3'), `steps stay in Claude's order (${order})`);
  const steps = await page.$$eval('.chip.step', (xs) => xs.map((x) => x.textContent).join());
  check(steps === 'Step 1 of 3,Step 2 of 3,Step 3 of 3', `steps are numbered (${steps})`);
  check(await page.$eval('#task-t3', (e) => !e.querySelector('.prio')), 'the last step gets no priority mark');
  check(await page.$eval('#task-t6', (e) => !!e.querySelector('.prio')), 'a task that can be done in any order keeps its priority mark');
  await page.close();

  // Without the important loose task, the first step is next, and the last step never is.
  list.tasks = list.tasks.filter((x) => !['t4', 't5', 't6'].includes(x.id));
  page = await open(list);
  check((await next(page)) === 't1', 'the first step is the next task, not the one tagged important');
  await page.close();
  list.tasks[0].shared = { at: 1, done: true, note: '', images: [] };
  page = await open(list);
  check((await next(page)) === 't2', 'after step 1 is shared, step 2 is next');
  await page.close();

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
