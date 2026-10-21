// The panel with a keyboard and a screen reader, the high-contrast light theme, the away time after midnight, and what closing warns about.
const __ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const EXT = __ROOT;
const { ChecklistStore, stillOpen } = require(EXT + '/dist/model.js');
let failed = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

// Closing asks first, and names everything still waiting on you: tasks not shared and questions not answered.
{
  const s = new ChecklistStore(), S = 'x';
  s.handleTool(S, {}, 'checklist_add_tasks', { title: 'T', tasks: ['One', 'Two'] });
  s.handleTool(S, {}, 'checklist_ask', { questions: [{ question: 'Q1?', options: ['A', 'B'] }, { question: 'Q2?', options: ['C', 'D'] }] });
  const id = s.all()[0].id;
  check(stillOpen(s.get(id)) === '2 tasks are still not shared. 2 questions are not answered yet. ', `closing warns about tasks and questions (${stillOpen(s.get(id))})`);
  s.setDraft(id, 't1', { done: true }); s.share(id, 't1');
  s.setAnswerDraft(id, 'q1', { picks: ['o1'] }); s.shareAnswer(id, 'q1');
  check(stillOpen(s.get(id)) === '1 task is still not shared. 1 question is not answered yet. ', 'one of each');
  s.setDraft(id, 't2', { done: true }); s.share(id, 't2');
  s.setAnswerDraft(id, 'q2', { picks: ['o1'] }); s.shareAnswer(id, 'q2');
  check(stillOpen(s.get(id)) === '', 'nothing waiting: no warning');
}

const pw = require('./harness/playwright');
if (!pw) { console.log('SKIP Playwright is not installed'); process.exit(failed ? 1 : 0); }
const { chromium } = pw;
const THEMES = require('./harness/themes');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function state() {
  const s = new ChecklistStore(), S = 'x';
  s.handleTool(S, {}, 'checklist_add_tasks', { title: 'T', tasks: [{ text: 'Restart the server', tags: ['urgent'] }, 'Read one', 'Unread one', 'Plain one'] });
  s.handleTool(S, {}, 'checklist_ask', { questions: [{ question: 'Pick a colour?', options: ['Red', 'Green', 'Blue'] }, { question: 'Done question?', options: ['Yes', 'No'] }] });
  const id = s.all()[0].id;
  s.setDraft(id, 't2', { done: true }); s.share(id, 't2');
  s.setAnswerDraft(id, 'q2', { picks: ['o2'], note: 'Because' }); s.shareAnswer(id, 'q2');
  s.handleTool(S, {}, 'checklist_read', {}); // Claude reads t2 and the answer to q2
  s.setDraft(id, 't3', { done: false, note: 'Could not' }); s.share(id, 't3');
  s.addImages(id, 't4', [{ mime: 'image/png', data: PNG, w: 1, h: 1 }]);
  return JSON.parse(JSON.stringify(s.get(id)));
}

// The page's clock can be moved: window.__shift(ms).
const CLOCK = (start) => `const R=Date;let off=${start}-R.now();window.__shift=(ms)=>{off+=ms};window.Date=class extends R{constructor(...a){a.length?super(...a):super(R.now()+off)}static now(){return R.now()+off}};`;

(async () => {
  const b = await chromium.launch();
  const css = fs.readFileSync(EXT + '/media/panel.css', 'utf8'), js = fs.readFileSync(EXT + '/media/panel.js', 'utf8');
  const open = async ({ theme = 'dark', body = 'vscode-dark', clock = '', list = state(), routes = { waiting: false, channel: false, terminal: false } } = {}) => {
    const page = await b.newPage({ viewport: { width: 420, height: 1400 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.setContent(`<!doctype html><html><head><style>html{${THEMES[theme]}}${css}</style></head><body class="${body}"><script>${clock}window.__out=[];window.__st=null;window.acquireVsCodeApi=()=>({postMessage:m=>window.__out.push(m),getState:()=>window.__st,setState(s){window.__st=s}});</script><script>${js}</script></body></html>`);
    page.send = (l = list, r = routes) => page.evaluate(([l, r]) => window.postMessage({ type: 'state', list: l, routes: r }, '*'), [l, r]);
    page.posted = (t) => page.evaluate((t) => window.__out.filter((m) => m.type === t), t);
    page.errs = errs;
    await page.send(); await page.waitForTimeout(250);
    return page;
  };
  const isOpen = (page, id) => page.$eval(`#task-${id}`, (e) => e.classList.contains('open'));
  const focused = (page) => page.evaluate(() => { const a = document.activeElement; return `${a.closest('[data-id]')?.dataset.id || ''} ${a.className}`; });

  // Keyboard: every row opens with Enter, shared questions included.
  {
    const page = await open();
    await page.click('text=Shared with Claude'); await page.waitForTimeout(150);
    for (const id of ['t1', 't2', 'q2']) {
      const before = await isOpen(page, id);
      await page.focus(`#task-${id} .row-main`); await page.keyboard.press('Enter'); await page.waitForTimeout(120);
      const after = await isOpen(page, id);
      await page.focus(`#task-${id} .row-main`); await page.keyboard.press(' '); await page.waitForTimeout(120);
      check(after !== before && (await isOpen(page, id)) === before, `${id}: Enter opens or shuts the row, and so does Space`);
    }
    // No control sits inside the row's button: a screen reader reads each one on its own.
    check(await page.evaluate(() => document.querySelectorAll('[role=button] input, [role=button] button, [role=button] [role=button]').length === 0), 'no checkbox, Share or id inside a row\'s button');
    // A click anywhere on the row still opens it.
    const before = await isOpen(page, 't4');
    await page.click('#task-t4 .row', { position: { x: 200, y: 12 } }); await page.waitForTimeout(120);
    check((await isOpen(page, 't4')) !== before, 'a click on the row still opens it');
    // The id is a button: Enter copies it, without opening the row.
    const was = await isOpen(page, 't3');
    await page.focus('#task-t3 .item-id'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    const copies = await page.posted('copy');
    check(copies.length === 1 && copies[0].text === 't3' && (await isOpen(page, 't3')) === was, 'the id copies from the keyboard too');
    // Ticking with Space keeps the focus on the checkbox when the window answers.
    await page.focus('#task-t1 .tick'); await page.keyboard.press(' '); await page.waitForTimeout(80);
    const l = state(); l.tasks.find((t) => t.id === 't1').draft.done = true;
    await page.send(l); await page.waitForTimeout(150);
    check((await focused(page)) === 't1 tick', `the checkbox keeps the focus after ticking (${await focused(page)})`);
    check(!page.errs.length, `no errors (${page.errs.join('; ')})`);
    await page.close();
  }

  // Screen readers hear what the colours and icons say.
  {
    const page = await open();
    await page.click('text=Shared with Claude'); await page.waitForTimeout(150);
    const nameOf = (id) => page.$eval(`#task-${id} .row-main`, (e) => e.textContent.replace(/\s+/g, ' ').trim());
    const role = async (re) => page.getByRole('button', { name: re }).count();
    // Close the pinned next task first: a closed urgent row shows a mark, not a chip.
    if (await isOpen(page, 't1')) { await page.click('#task-t1 .row'); await page.waitForTimeout(120); }
    check(/Urgent/.test(await nameOf('t1')) && (await role(/Restart the server.*Urgent/)) === 1, `a closed urgent row says Urgent (${await nameOf('t1')})`);
    check(/Shared as done\. Claude has read this\./.test(await nameOf('t2')) && (await role(/Read one.*Shared as done/)) === 1, `a shared row says how it was shared and that Claude read it (${await nameOf('t2')})`);
    check(/Shared as not done\. Claude hasn’t read this yet\./.test(await nameOf('t3')), `…or that Claude hasn't read it yet (${await nameOf('t3')})`);
    check(/Your answer:.*No.*Claude has read this/.test(await nameOf('q2')), `a read answer says the answer and that Claude read it (${await nameOf('q2')})`);
    if (await isOpen(page, 't4')) { await page.click('#task-t4 .row'); await page.waitForTimeout(120); }
    check(/1 screenshot/.test(await nameOf('t4')), `the screenshot count is a phrase, not a lone number (${await nameOf('t4')})`);
    check(await page.evaluate(() => [...document.querySelectorAll('.mark, .prio, .right .status')].every((e) => e.closest('[aria-hidden="true"]'))), 'the marks themselves are hidden from screen readers, so nothing is read twice');
    // Nothing of that shows on screen.
    check(await page.$$eval('.sr', (xs) => xs.length > 0 && xs.every((x) => x.getBoundingClientRect().width <= 1)), 'the extra words take no room on screen');
    await page.close();
  }

  // A screenshot opens full size from the keyboard, and closing it goes back to it.
  {
    const page = await open();
    if (!(await isOpen(page, 't4'))) { await page.click('#task-t4 .row'); await page.waitForTimeout(120); }
    await page.focus('#task-t4 .shot-open'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    check(!!(await page.$('.lightbox')), 'Enter on a screenshot shows it full size');
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    check(!(await page.$('.lightbox')) && (await focused(page)) === 't4 shot-open', `Escape closes it and the focus goes back to the screenshot (${await focused(page)})`);
    check(await page.$eval('#task-t4 .shot .x', (e) => getComputedStyle(e).opacity === '1'), 'with the screenshot focused, its remove button shows');
    await page.close();
  }

  // One choice: one Tab stop, and the arrow keys move between the choices and pick them.
  {
    const page = await open();
    const stops = () => page.$$eval('#task-q1 .opt-main', (bs) => bs.map((x) => x.tabIndex).join(','));
    check((await stops()) === '0,-1,-1,-1', `one Tab stop before anything is picked (${await stops()})`);
    await page.focus('#task-q1 .opt-main'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(80);
    const picks = (await page.posted('answerDraft')).map((m) => m.picks.join());
    check(picks.at(-1) === 'o2' && (await stops()) === '-1,0,-1,-1' && (await page.evaluate(() => document.activeElement.closest('.opt').dataset.opt)) === 'o2', `ArrowDown picks the next choice and moves there (${picks.join(' ')})`);
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(80);
    const onOpt = () => page.evaluate(() => document.activeElement.closest('.opt')?.dataset.opt);
    check((await page.posted('answerDraft')).at(-1).picks.join() === 'other' && (await onOpt()) === 'other', 'ArrowUp from the first choice goes round to the last, and "Something else" doesn\'t pull the focus into its box');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(80);
    // A redraw (here: a screenshot was added) keeps the focus on the choice you were on.
    const l = state(); l.questions.find((q) => q.id === 'q1').rev++; l.questions.find((q) => q.id === 'q1').draft.picks = ['o3'];
    await page.send(l); await page.waitForTimeout(150);
    check((await onOpt()) === 'o3', `a redraw keeps the focus on the same choice (${await onOpt()})`);
    // Several choices: every one is its own Tab stop, as with checkboxes.
    const m = state(); Object.assign(m.questions.find((q) => q.id === 'q1'), { multi: true, rev: 99 });
    await page.send(m); await page.waitForTimeout(150);
    check((await stops()) === '0,0,0,0', `with several choices, each is a Tab stop (${await stops()})`);
    await page.close();
  }

  // The high-contrast light theme is white, so it gets the darker colours.
  {
    const page = await open({ theme: 'light', body: 'vscode-high-contrast vscode-high-contrast-light' });
    const v = await page.evaluate(() => { const s = getComputedStyle(document.body); return ['--done', '--important', '--quick', '--accent'].map((x) => s.getPropertyValue(x).trim()).join(' '); });
    check(v === '#1a7f37 #9a6700 #0e7c86 #4f54d9', `high-contrast light uses the light-theme colours (${v})`);
    const d = await open({ theme: 'mine', body: 'vscode-high-contrast' });
    const dv = await d.evaluate(() => getComputedStyle(document.body).getPropertyValue('--done').trim());
    check(dv === '#3fb950', `high-contrast dark keeps the bright ones (${dv})`);
    await page.close(); await d.close();
  }

  // Only the current task is tinted: the "Claude is waiting" banner and the away card are not.
  {
    const page = await open({ routes: { waiting: true, channel: false, terminal: false } });
    const bg = (sel) => page.$eval(sel, (e) => getComputedStyle(e).backgroundColor);
    const raise = await page.evaluate(() => { const x = document.createElement('div'); x.style.background = 'var(--raise)'; document.body.append(x); const c = getComputedStyle(x).backgroundColor; x.remove(); return c; });
    check((await bg('.waiting')) === raise && (await bg('.task.current.open')) !== raise, 'the waiting banner is not tinted; the current task is');
    await page.close();
  }

  // Away past midnight: "tomorrow" is worked out when shown, not saved with the time.
  {
    const page = await open({ clock: CLOCK('new R(2026,0,15,23,0,0).getTime()') });
    await page.click('#away-btn'); await page.waitForTimeout(450);
    await page.click('.away-chip >> text=4 hours'); await page.waitForTimeout(450);
    check(/Away until tomorrow 3:00 AM\?/.test(await page.$eval('.away-card', (e) => e.textContent)), 'the question says tomorrow');
    await page.click('.away-card >> text=Yes'); await page.waitForTimeout(80);
    const set = (await page.posted('setAway'))[0];
    check(set && set.label === '3:00 AM', `the window gets only the time of day (${set && set.label})`);
    const away = (left, label) => { const l = state(); Object.assign(l, { away: true, awayUntil: 1e12 + left, awayLabel: label, awayLeft: left, awayMs: 4 * 3600_000 }); return l; };
    await page.send(away(4 * 3600_000, '3:00 AM')); await page.waitForTimeout(450);
    const until = () => page.$eval('#away-until', (e) => e.textContent);
    check((await until()) === 'tomorrow 3:00 AM', `before midnight: tomorrow 3:00 AM (${await until()})`);
    await page.evaluate(() => window.__shift(2 * 3600_000)); // 1:00 AM
    await page.send(away(2 * 3600_000, '3:00 AM')); await page.waitForTimeout(200);
    check((await until()) === '3:00 AM', `after midnight: 3:00 AM, not tomorrow (${await until()})`);
    await page.send(away(2 * 3600_000 - 1000, 'tomorrow 3:00 AM')); await page.waitForTimeout(200); // saved by an older panel
    check((await until()) === '3:00 AM', `an older saved "tomorrow" is dropped after midnight too (${await until()})`);
    check(!page.errs.length, `no errors (${page.errs.join('; ')})`);
    await page.close();
  }

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
