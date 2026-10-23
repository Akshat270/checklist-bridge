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
  check(seq() === 'bac' && /left out, and tasks the user has already shared, kept their places/.test(r), 'a partial list swaps those tasks and leaves the others where they are');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { step_order: ['t1', 't4'] }));
  check(/same group/.test(r) && seq() === 'bac', 'tasks from different groups are refused, with a note');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { step_order: ['t1', 't99'] }));
  check(/t99 is not a task/.test(r) && /at least two/.test(r) && seq() === 'bac', 'an unknown id is reported and nothing moves');
  // A step the user has already shared is not moved, so completed steps keep their numbers.
  q.setDraft(qc.id, 't1', { done: true }); q.share(qc.id, 't1');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { step_order: ['t3', 't2', 't1'] }));
  check(seq() === 'cab' && /t1 is already shared/.test(r) && qc.tasks.filter((x) => x.group === 'Seq')[1].text === 'a', 'a step the user already shared is not moved, and the others still swap around it');
  r = text(await q.handleTool(Q, {}, 'checklist_edit', { unordered_groups: ['Seq'], step_order: ['t1', 't2', 't3'] }));
  check(/not an ordered group/.test(r) && seq().length === 3, 'reordering a group that is not ordered works, with a reminder');

  // Phases: stages of a roadmap that are done one after another.
  const buildRoad = () => {
    const st = new ChecklistStore();
    st.handleTool('r', {}, 'checklist_add_tasks', {
      title: 'Testing roadmap',
      phases: ['Setting up', 'Testing', 'Wrapping up'],
      tasks: [
        { text: 'Install the build', group: 'Setting up' }, { text: 'Create a test account', group: 'Setting up' }, { text: 'Load sample data', group: 'Setting up' },
        { text: 'Run the happy path', group: 'Testing' }, { text: 'Try bad input', group: 'Testing', tags: ['urgent'] },
        { text: 'Write up the results', group: 'Wrapping up', tags: ['important'] }, { text: 'Tell the team', group: 'Wrapping up' },
      ],
    });
    return st;
  };
  const rs = buildRoad(), rc = rs.all()[0];
  check(rc.phases.join() === 'Setting up,Testing,Wrapping up', 'add_tasks sets the phases of a roadmap');
  r = text(await rs.handleTool('r', {}, 'checklist_read', {}));
  check(/Setting up \(phase 1 of 3/.test(r) && /Testing \(phase 2 of 3/.test(r) && /- t4 \(step 4 of 7\) Run the happy path/.test(r) && /- t7 \(step 7 of 7\) Tell the team/.test(r), 'checklist_read shows the phase and a step number across the whole roadmap');
  r = text(await rs.handleTool('r', {}, 'checklist_add_tasks', { phases: ['Setting up', 'Nowhere', 'Testing'], tasks: [{ text: 'extra', group: 'Testing' }] }));
  check(rc.phases.join() === 'Setting up,Testing' && /Nowhere: no task is in a group/.test(r), 'a phase name no task uses is dropped, and Claude is told');
  await rs.handleTool('r', {}, 'checklist_edit', { phases: ['Wrapping up', 'Setting up', 'Testing'] });
  r = text(await rs.handleTool('r', {}, 'checklist_read', {}));
  check(/Wrapping up \(phase 1 of 3/.test(r) && /Setting up \(phase 2 of 3/.test(r) && /- t6 \(step 1 of 8\)/.test(r), 'edit with phases reorders the stages');
  r = text(await rs.handleTool('r', {}, 'checklist_edit', { updates: [{ id: 't1', group: 'Testing' }] }));
  check(/t1 is now step 8 of 8 in "Testing"/.test(r), 'a task moved into a phase becomes its last step, counted across the roadmap');
  r = text(await rs.handleTool('r', {}, 'checklist_edit', { unordered_groups: ['Testing'] }));
  check(/Testing is a phase/.test(r) && rc.phases.includes('Testing'), 'a phase cannot be made unordered, and Claude is told');
  r = text(await rs.handleTool('r', {}, 'checklist_edit', { remove: rc.tasks.filter((x) => x.group === 'Wrapping up').map((x) => x.id) }));
  check(/Wrapping up has no tasks left, so it is no longer a phase/.test(r) && rc.phases.join() === 'Setting up,Testing', 'an emptied phase is dropped, with a note');
  await rs.handleTool('r', {}, 'checklist_edit', { phases: [] });
  check(rc.phases.length === 0 && !rc.orderedGroups.length, 'phases: [] removes the roadmap');
  // Several ordered groups are independent: Claude is pointed at phases.
  const sv = new ChecklistStore();
  r = text(await sv.handleTool('v', {}, 'checklist_add_tasks', { ordered_groups: ['One', 'Two'], tasks: [{ text: 'a', group: 'One' }, { text: 'b', group: 'Two' }] }));
  check(/independent of each other/.test(r) && /phases/.test(r), 'naming several ordered groups without phases points Claude at phases');
  r = text(await sv.handleTool('v', {}, 'checklist_add_tasks', { ordered_groups: ['One', 'Two'], phases: ['One', 'Two'], tasks: [{ text: 'c', group: 'One' }] }));
  check(!/independent of each other/.test(r), 'no nudge when the groups are also given as phases');

  r = text(await rs.handleTool('r', {}, 'checklist_edit', { phases: ['Setting up', 'Testing'] }));
  r = text(await rs.handleTool('r', {}, 'checklist_edit', { ordered_groups: ['Setting up', 'Testing'] }));
  check(!/independent of each other/.test(r), 'no nudge when the named groups are already phases');
  r = text(await rs.handleTool('r', {}, 'checklist_edit', { updates: [{ id: 't1', group: 'Testing' }], step_order: ['t1', 't4'] }));
  check(!/Use step_order/.test(r), 'no step_order hint when the same call already used it');
  const oldRoad = JSON.parse(JSON.stringify(buildRoad().all()[0])); delete oldRoad.phases;
  check(normalize(oldRoad).phases.length === 0, 'a checklist saved before phases existed still loads');

  const old = JSON.parse(JSON.stringify(build().s.get(id) || c)); delete old.orderedGroups;
  check(normalize(old).orderedGroups.length === 0, 'a checklist saved before this change still loads');

  // A task moved into an ordered group and removed in the same call stays removed.
  {
    const { s: s2, S: S2 } = build();
    const before = s2.all()[0].tasks.map((t) => t.id);
    r = text(s2.handleTool(S2, {}, 'checklist_edit', { updates: [{ id: 't5', group: 'Release' }], remove: ['t5'] }));
    check(!s2.all()[0].tasks.some((t) => t.id === 't5') && s2.all()[0].tasks.length === before.length - 1 && !/t5 is now step/.test(r), 'a task moved into an ordered group and removed in the same call stays removed');
  }

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
  // Where the next task is shown: the section named by its heading, or 'ungrouped' (the tasks without a group, at the top).
  // There is no section of its own above them any more: the next task always stays where it belongs.
  const where = (page) => page.$eval('.task.current', (x) => {
    if (document.querySelector('[aria-label="Next task"]')) return 'pinned';
    const sec = x.closest('section');
    return (sec.querySelector('.section-head span') || {}).textContent || 'ungrouped';
  }).catch(() => null);
  const first = (page) => page.$eval('.task', (x) => x.dataset.id);

  let list = JSON.parse(JSON.stringify(build().s.all()[0]));
  let page = await open(list);
  check((await next(page)) === 't4' && (await where(page)) === 'ungrouped' && (await first(page)) === 't4', 'an important task without a group is the next task, first among the ungrouped tasks at the top');
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

  // Phases in the panel.
  {
    const roadList = () => JSON.parse(JSON.stringify(buildRoad().all()[0]));
    let rl = roadList();
    let pg = await open(rl);
    const heads = await pg.$$eval('.section-head', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
    check(heads.join('|') === 'Setting up3Phase 1 of 3|Testing2Phase 2 of 3|Wrapping up2Phase 3 of 3', `phases show in order with their place (${heads.join(' | ')})`);
    const ord = (await ids(pg)).split(' ');
    check(ord.join() === 't1,t2,t3,t4,t5,t6,t7', `tasks stay in roadmap order whatever their tags (${ord})`);
    const chips = await pg.$$eval('.chip.step', (xs) => xs.map((x) => x.textContent).join());
    check(chips.startsWith('Step 1 of 7,Step 2 of 7') && chips.endsWith('Step 7 of 7'), `steps are numbered across the roadmap (${chips})`);
    check((await next(pg)) === 't1' && (await where(pg)) === 'Setting up', 'only the first task of the first phase is next, in its phase');
    check(await pg.$eval('#task-t5', (e) => !e.querySelector('.prio') && !e.classList.contains('urgent')) && await pg.$eval('#task-t6', (e) => !e.querySelector('.prio')), 'an urgent or important task of a later step gets no priority mark');
    // Collapsing the phase that holds the next task does not make the task jump to the top.
    await pg.click('.section-head:has-text("Setting up")');
    await pg.waitForTimeout(200);
    check(!(await pg.$('[aria-label="Next task"]')) && (await pg.$eval('.section-head:has-text("Setting up")', (x) => x.textContent)).includes('next task inside'), 'collapsing the group with the next task hides it there, with a hint, instead of pinning it above');
    await pg.click('.section-head:has-text("Setting up")');
    await pg.waitForTimeout(200);
    check((await where(pg)) === 'Setting up', 'opening the group again shows the next task in its place');
    await pg.close();
    for (const id of ['t1', 't2', 't3']) rl.tasks.find((x) => x.id === id).shared = { at: 1, done: true, note: '', images: [] };
    pg = await open(rl);
    const heads2 = await pg.$$eval('.section-head', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()).filter((x) => /Phase/.test(x)));
    check((await next(pg)) === 't4' && (await where(pg)) === 'Testing' && heads2[0] === 'Testing2Phase 2 of 3', `when phase 1 is shared, the first task of phase 2 is next, in its phase, and keeps its number (${heads2[0]})`);
    await pg.close();
    rl = roadList();
    rl.tasks.push({ id: 't99', text: 'Fix the build now', tags: ['urgent'], addedAt: 1, rev: 1, draft: { done: false, note: '', images: [] } });
    pg = await open(rl);
    check((await next(pg)) === 't99' && (await where(pg)) === 'ungrouped' && (await first(pg)) === 't99', 'an urgent task outside the roadmap can still be next, at the top');
    await pg.close();
  }

  // An ordinary group (any order): its task that is next stays in the group, under its heading, not pulled out above it.
  {
    const s = new ChecklistStore(), S = 'x';
    s.handleTool(S, {}, 'checklist_add_tasks', {
      title: 'Launch',
      tasks: [
        { text: 'Write the release notes', group: 'Docs' },
        { text: 'Create the Razorpay account', group: 'Payments' },
        { text: 'Add the key to .env', group: 'Payments', tags: ['urgent'] },
        { text: 'Check the pricing page', group: 'Payments' },
      ],
    });
    const pl = JSON.parse(JSON.stringify(s.all()[0]));
    let pg = await open(pl);
    const inGroup = await pg.$eval('.task.current', (x) => {
      const sec = x.closest('section');
      return [x.dataset.id, sec.querySelector('.section-head span')?.textContent, [...sec.querySelectorAll('.task')].map((t) => t.dataset.id).join(' ')];
    });
    check((await where(pg)) === 'Payments' && inGroup.join('|') === 't3|Payments|t3 t2 t4', `the urgent next task stays in its group, first there (${inGroup.join(' | ')})`);
    check((await pg.$$eval('.section-head span:first-of-type', (xs) => xs.map((x) => x.textContent).join())) === 'Docs,Payments' && (await first(pg)) === 't1', 'the groups keep their order: the next task does not move its group up');
    check(await pg.$eval('#task-t3', (e) => e.classList.contains('open') && !e.querySelector('.chip.soft')), 'it is open and tinted there, without its group name repeated as a tag');
    check(await pg.$eval('.section-head:has-text("Payments") .count', (x) => x.textContent === '3'), 'its group counts it');
    // Collapsing the group hides it there too, with a hint.
    await pg.click('.section-head:has-text("Payments")'); await pg.waitForTimeout(200);
    check(!(await pg.$('.task.current')) && (await pg.$eval('.section-head:has-text("Payments")', (x) => x.textContent)).includes('next task inside'), 'collapsing its group hides it there, with a hint');
    await pg.close();
    // Shared, the next one in the group takes its place.
    pl.tasks.find((x) => x.id === 't3').shared = { at: 1, done: true, note: '', images: [] };
    pg = await open(pl);
    check((await next(pg)) === 't1' && (await where(pg)) === 'Docs', 'when it is shared, the next task is the first one left, in its own group');
    await pg.close();
  }

  // The next task is never hidden or out of view because it stays in its group.
  {
    const s = new ChecklistStore(), S = 'x';
    s.handleTool(S, {}, 'checklist_add_tasks', {
      title: 'Long',
      tasks: [...Array.from({ length: 15 }, (_, i) => ({ text: `Read page ${i + 1}`, group: 'Docs' })), { text: 'Add the key', group: 'Payments', tags: ['urgent'] }, { text: 'Test the payment', group: 'Payments', tags: ['urgent'] }],
    });
    const pl = JSON.parse(JSON.stringify(s.all()[0]));
    const send = (pg, l) => pg.evaluate((x) => window.postMessage({ type: 'state', list: x, routes: { waiting: false, channel: false, terminal: false } }, '*'), l);
    const pg = await open(pl);
    // You collapse Docs; Claude then makes a Docs task urgent: it becomes the next task, and Docs opens again.
    await pg.click('.section-head:has-text("Docs")'); await pg.waitForTimeout(150);
    const l2 = JSON.parse(JSON.stringify(pl)); Object.assign(l2.tasks.find((x) => x.id === 't9'), { tags: ['urgent'], rev: 5 });
    for (const id of ['t16', 't17']) l2.tasks.find((x) => x.id === id).tags = [];
    await send(pg, l2); await pg.waitForTimeout(200);
    check((await next(pg)) === 't9' && (await pg.$eval('.section-head:has-text("Docs")', (x) => x.getAttribute('aria-expanded'))) === 'true', 'when the next task moves into a group you collapsed, the group opens');
    // Collapsing the group the next task is already in keeps it shut, with the hint.
    await pg.click('.section-head:has-text("Docs")'); await pg.waitForTimeout(150);
    await send(pg, l2); await pg.waitForTimeout(150);
    check((await pg.$eval('.section-head:has-text("Docs")', (x) => x.getAttribute('aria-expanded'))) === 'false', 'collapsing the group it is already in keeps it shut');
    await pg.close();
    // After you share the next task, the new one is scrolled into view, even far down in its group.
    const pg2 = await open(pl);
    await pg2.setViewportSize({ width: 400, height: 500 });
    await pg2.evaluate(() => scrollTo(0, 0));
    const l3 = JSON.parse(JSON.stringify(pl)); l3.tasks.find((x) => x.id === 't16').shared = { at: 1, done: true, note: '', images: [] };
    await send(pg2, l3); await pg2.waitForTimeout(900); // the share's slide and the scroll
    const seen = await pg2.$eval('.task.current', (x) => { const r = x.getBoundingClientRect(); return [x.dataset.id, r.top >= 0 && r.top < innerHeight]; });
    check(seen.join() === 't17,true', `after sharing, the next task is scrolled into view (${seen})`);
    await pg2.close();
  }

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
