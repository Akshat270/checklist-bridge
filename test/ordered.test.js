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
  check(/is now step 3 of 3 in "Run"/.test(r) && c.tasks.filter((x) => x.group === 'Run').pop().id === early, 'a task moved into an ordered group becomes its last step, and Claude is told');
  // Review: the same task twice in one call is moved once, and the numbers in the notes are the final ones.
  const a = c.tasks.find((x) => x.text === 'first').id, b2 = c.tasks.find((x) => x.text === 'second').id;
  await s.handleTool(S, {}, 'checklist_edit', { updates: [{ id: a, group: 'Out' }, { id: b2, group: 'Out' }] });
  r = text(await s.handleTool(S, {}, 'checklist_edit', { updates: [{ id: a, group: 'Run' }, { id: b2, group: 'Elsewhere' }, { id: a, group: 'Run' }, { id: b2, group: 'Run' }] }));
  check((r.match(/is now step/g) || []).length === 2 && new RegExp(a + ' is now step 2 of 3').test(r) && new RegExp(b2 + ' is now step 3 of 3').test(r), 'the same task twice in one call is moved once, with the final step numbers');
  // Review: renaming an ordered group says that the order was lost.
  const runIds = c.tasks.filter((x) => x.group === 'Run').map((x) => x.id);
  r = text(await s.handleTool(S, {}, 'checklist_edit', { updates: runIds.map((id) => ({ id, group: 'Renamed' })) }));
  check(/Run has no tasks left, so it is no longer an ordered group/.test(r) && !c.orderedGroups.includes('Renamed'), 'renaming an ordered group tells Claude the order was lost');
  await s.handleTool(S, {}, 'checklist_edit', { updates: runIds.map((id) => ({ id, group: 'Run' })), ordered_groups: ['Run'] });
  r = text(await s.handleTool(S, {}, 'checklist_edit', { ordered_groups: ['Run'], unordered_groups: ['Run '] }));
  check(c.orderedGroups.includes('Run') && /Run was in both/.test(r), 'a group in both lists stays ordered, with a note, even if spelled with extra spaces');

  // Reordering the steps of a group (step_order).
  const q = new ChecklistStore(); const Q = 'q';
  await q.handleTool(Q, {}, 'checklist_add_tasks', { ordered_groups: ['Seq'], tasks: [{ text: 'a', group: 'Seq' }, { text: 'b', group: 'Seq' }, { text: 'c', group: 'Seq' }, { text: 'loose' }] });
  const qc = q.all()[0];
  const seq = () => qc.tasks.filter((x) => x.group === 'Seq').map((x) => x.text).join('');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { step_order: ['t3', 't1', 't2'] }));
  check(seq() === 'cab' && /"Seq" is now in this order: t3, t1, t2/.test(r) && qc.tasks.length === 4, 'step_order puts the steps in the given order');
  r = text(await q.handleTool(Q, {}, 'checklist_read', {}));
  check(/\(step 1 of 3\) c/.test(r) && /\(step 3 of 3\) b/.test(r), 'checklist_read then shows the new step numbers');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { step_order: ['t2', 't3'] }));
  check(seq() === 'bac' && /left out kept their places/.test(r), 'a partial list swaps those tasks and leaves the others where they are');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { step_order: ['t1', 't4'] }));
  check(/same group/.test(r) && seq() === 'bac', 'tasks from different groups are refused, with a note');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { step_order: ['t1', 't99'] }));
  check(/t99 is not a task/.test(r) && /at least two/.test(r) && seq() === 'bac', 'an unknown id is reported and nothing moves');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { unordered_groups: ['Seq'], step_order: ['t1', 't2', 't3'] }));
  check(/not an ordered group/.test(r) && seq() === 'abc', 'reordering a group that is not ordered works, with a reminder');

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
  const next = (page) => page.$eval('.task.current', (x) => x.dataset.id).catch(() => null);
  // Where the next task is shown: the section named by its heading, or pinned above as "Next task".
  const where = (page) => page.$eval('.task.current', (x) => {
    const sec = x.closest('section');
    return sec.getAttribute('aria-label') === 'Next task' ? 'pinned' : (sec.querySelector('.section-head span') || {}).textContent;
  }).catch(() => null);

  let list = JSON.parse(JSON.stringify(build().s.all()[0]));
  let page = await open(list);
  check((await next(page)) === 't4' && (await where(page)) === 'pinned', 'an important task that can be done in any order is still the next task, pinned above');
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
  check((await where(page)) === 'Release', 'the next task, being a step, stays in its Release section instead of being pinned above');
  check(await page.$eval('#task-t1', (e) => !!e.querySelector('.note-box > .attach') && !/Add image/.test(e.textContent) && getComputedStyle(e.querySelector('.actions')).display === 'none'), 'an open task has no row of its own for adding an image, only an icon in the note');
  await page.fill('#task-t1 textarea', 'done it');
  check(await page.$eval('#task-t1', (e) => getComputedStyle(e.querySelector('.actions')).display !== 'none' && !e.querySelector('.share-btn').hidden), 'the share row appears once there is a note');
  check(await page.$eval('#task-t1', (e) => e.classList.contains('link') && parseFloat(getComputedStyle(e, '::before').top) >= e.offsetHeight - 1), 'the line between steps does not run through an open step, only below it');
  check(await page.$eval('#task-t1', (e) => e.classList.contains('open') && !!e.closest('section').querySelector('#task-t2') && !e.querySelector('.chip.soft:not(.step)')), 'it is open in its place, ahead of the later steps, without a repeated group chip');
  await page.close();
  list.tasks[0].shared = { at: 1, done: true, note: '', images: [] };
  page = await open(list);
  check((await next(page)) === 't2' && (await where(page)) === 'Release', 'after step 1 is shared, step 2 is next, still in its section');
  await page.close();

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
