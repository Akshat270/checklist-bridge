// The panel with a keyboard and a screen reader, the high-contrast light theme, the away time after midnight, and what closing warns about.
const __ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const EXT = __ROOT;
const { ChecklistStore, stillOpen, awayDay } = require(EXT + '/dist/model.js');
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
  s.setAnswerDraft(id, 'q2', { picks: ['o1'] });
  check(stillOpen(s.get(id)) === '1 answer is still not shared. ', `an answer picked but not shared is called that, not "not answered" (${stillOpen(s.get(id))})`);
  s.setAnswerDraft(id, 'q2', { picks: ['other'], other: ' ' });
  check(stillOpen(s.get(id)) === '1 question is not answered yet. ', '"Something else" with nothing typed is not an answer yet');
  s.setAnswerDraft(id, 'q2', { picks: ['o1'] }); s.shareAnswer(id, 'q2');
  check(stillOpen(s.get(id)) === '', 'nothing waiting: no warning');
}

// Claude is told "tomorrow" while the away ends after the user's midnight, and not once that midnight has come.
{
  const s = new ChecklistStore(), S = 'x';
  s.handleTool(S, {}, 'checklist_add_tasks', { title: 'T', tasks: ['One'] });
  const c = s.all()[0], now = Date.now();
  s.setAway(c.id, 8 * 3600_000, '6:00 AM', 2 * 3600_000, now); // 10 PM: midnight is in 2 hours
  check(awayDay(c, now) === 'tomorrow ' && /until tomorrow 6:00 AM \(in 8 hours\)/.test(s.awayNote(c)), `before midnight Claude reads "tomorrow 6:00 AM" (${s.awayNote(c).slice(0, 50)})`);
  check(awayDay(c, now + 2 * 3600_000) === '', 'from midnight on, it is today');
  s.setAway(c.id, 3600_000, '11:00 PM', undefined, now);
  check(awayDay(c, now) === '' && /until 11:00 PM \(in 1 hour\)/.test(s.awayNote(c)), 'an away that ends the same day says no day');
  s.setAway(c.id, 3600_000, '11:00 PM', 2 * 3600_000, now);
  check(c.awayMidnight === undefined, 'a midnight after the end is ignored');
  s.endAway(c.id);
  check(c.awayMidnight === undefined, 'ending the away forgets it');
}

const pw = require('./harness/playwright');
if (!pw) { console.log('SKIP Playwright is not installed'); process.exit(failed ? 1 : 0); }
const { chromium } = pw;
const THEMES = require('./harness/themes');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// The same checklist every time (same ids), as one window would send it again and again.
let BASE;
const state = () => JSON.parse(JSON.stringify(BASE ??= build()));
function build() {
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

  // While a screenshot is open, nothing behind it can be reached, and Escape closes only it.
  {
    const page = await open();
    if (!(await isOpen(page, 't4'))) { await page.click('#task-t4 .row'); await page.waitForTimeout(120); }
    await page.click('#away-btn'); await page.waitForTimeout(450); // the away picker is open too
    await page.focus('#task-t4 .shot-open'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    check(await page.evaluate(() => document.querySelector('.page').inert && document.querySelector('#dock').inert), 'the page and the bar behind it are out of reach');
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.waitForTimeout(50);
    check(await page.evaluate(() => document.activeElement.classList.contains('lightbox')), 'Tab stays on the screenshot');
    // The panel is drawn again while it is open (Claude added a screenshot): the screenshot button is a new one.
    const l = state(); l.tasks.find((t) => t.id === 't4').rev++;
    await page.send(l); await page.waitForTimeout(150);
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    check(!(await page.$('.lightbox')) && (await focused(page)) === 't4 shot-open', `after a redraw, Escape still goes back to the screenshot (${await focused(page)})`);
    check((await page.$eval('#away', (e) => e.classList.contains('open'))) && (await page.$$('.away-chip')).length === 4, 'Escape left the away picker open');
    check(!(await page.evaluate(() => document.querySelector('.page').inert)), 'the page is in reach again');
    check(!page.errs.length, `no errors (${page.errs.join('; ')})`);
    await page.close();
  }

  // The bar with Share all can be reached only while it shows, and sharing from it leaves the focus in the list.
  {
    const two = state(); for (const id of ['t1', 't4']) two.tasks.find((t) => t.id === id).draft.done = true;
    const page = await open({ list: two });
    check(!(await page.$eval('#dock', (e) => e.inert)) && !(await page.$eval('#dock', (e) => e.closest('[aria-hidden="true"]'))), 'two ticked: the bar shows and can be reached');
    await page.focus('#share-all'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
    // The window shares them and sends the new state.
    const after = state(); for (const id of ['t1', 't4']) { const t = after.tasks.find((x) => x.id === id); t.shared = { done: true, note: '', images: [], at: Date.now() }; }
    await page.send(after); await page.waitForTimeout(300);
    check(await page.$eval('#dock', (e) => e.inert), 'when the bar goes, it is out of reach');
    check(await page.evaluate(() => document.activeElement.closest('#list') === document.querySelector('#list')), `the focus goes back to the top of the list (${await focused(page)})`);
    await page.close();
  }

  // A redraw keeps the focus on the control you were on, whatever it is.
  {
    const page = await open();
    const imageBtn = '#task-q1 .actions .ghost:not(.add-note)';
    await page.focus(imageBtn);
    await page.send(); await page.waitForTimeout(150); // same card, moved
    check(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), imageBtn), 'the Image button keeps the focus when the card is kept');
    const l = state(); l.questions.find((q) => q.id === 'q1').rev++;
    await page.send(l); await page.waitForTimeout(150); // a new card
    check(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), imageBtn), `…and when it is drawn again (${await focused(page)})`);
    // An option's Details stays open, with the focus on it.
    const withDetails = state(); withDetails.questions.find((q) => q.id === 'q1').options[1].details = 'More about Green';
    await page.send(withDetails); await page.waitForTimeout(150);
    await page.click('#task-q1 summary'); await page.waitForTimeout(80);
    const again = JSON.parse(JSON.stringify(withDetails)); again.questions.find((q) => q.id === 'q1').rev += 2;
    await page.send(again); await page.waitForTimeout(150);
    check(await page.$eval('#task-q1 details', (e) => e.open && document.activeElement.tagName === 'SUMMARY'), 'an open Details stays open, and keeps the focus');
    check(!page.errs.length, `no errors (${page.errs.join('; ')})`);
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
    const ahead = set && set.midnightIn - 3600_000; // the page's clock was a moment past 11 PM when Yes was pressed
    check(set && set.label === '3:00 AM' && ahead <= 0 && ahead > -5000, `the window gets the time of day and how long until midnight (${set && set.label}, ${set && set.midnightIn} ms)`);
    // The window as the extension runs it: the real store, and the state the panel gets (as panels.ts builds it).
    const st = new ChecklistStore();
    st.handleTool('x', {}, 'checklist_add_tasks', { title: 'T', tasks: ['One'] });
    const c = st.all()[0], t0 = Date.now();
    st.setAway(c.id, set.ms, set.label, set.midnightIn, t0);
    const away = (at, extra) => Object.assign(state(), {
      away: true, awayUntil: c.awayUntil, awayLabel: c.awayLabel, awayMs: c.awayMs, awayLeft: c.awayUntil - at,
      awayMidnightLeft: c.awayMidnight ? c.awayMidnight - at : undefined,
    }, extra);
    await page.send(away(t0)); await page.waitForTimeout(450);
    const until = () => page.$eval('#away-until', (e) => e.textContent);
    check((await until()) === 'tomorrow 3:00 AM', `before midnight: tomorrow 3:00 AM (${await until()})`);
    await page.evaluate(() => window.__shift(2 * 3600_000)); // 1:00 AM
    await page.send(away(t0 + 2 * 3600_000)); await page.waitForTimeout(200);
    check((await until()) === '3:00 AM' && awayDay(c, t0 + 2 * 3600_000) === '', `after midnight: 3:00 AM, for the panel and for Claude (${await until()})`);
    await page.send(away(t0 + 2 * 3600_000, { awayLabel: 'tomorrow 3:00 AM', awayMidnightLeft: undefined, awayUntil: c.awayUntil + 1 })); await page.waitForTimeout(200); // saved by an older panel
    check((await until()) === '3:00 AM', `an older saved "tomorrow" is dropped after midnight too (${await until()})`);
    check(!page.errs.length, `no errors (${page.errs.join('; ')})`);
    await page.close();
  }

  // An away that ends at 11:59 PM stays "11:59 PM", even if a few seconds of delay put the end just past midnight.
  {
    const page = await open({ clock: CLOCK('new R(2026,0,15,23,59,58).getTime()') });
    const l = Object.assign(state(), { away: true, awayUntil: 5e12, awayLabel: '11:59 PM', awayLeft: 3000, awayMs: 60_000 });
    await page.send(l); await page.waitForTimeout(300);
    const until = await page.$eval('#away-until', (e) => e.textContent);
    check(until === '11:59 PM', `no "tomorrow" in front of a time from today (${until})`);
    await page.close();
  }

  // The away card is a live region: its text is only changed when it changes, and the countdown isn't read out.
  {
    const page = await open();
    const l = Object.assign(state(), { away: true, awayUntil: 6e12, awayLabel: '3:00 PM', awayLeft: 2 * 3600_000, awayMs: 2 * 3600_000 });
    await page.send(l); await page.waitForTimeout(450);
    await page.evaluate(() => { window.__muts = 0; new MutationObserver((m) => (window.__muts += m.length)).observe(document.querySelector('#away-until'), { childList: true, characterData: true, subtree: true }); });
    await page.waitForTimeout(15_500); // one tick of the countdown
    check((await page.evaluate(() => window.__muts)) === 0, 'the end time is not written again on every tick');
    check((await page.$eval('#away-left', (e) => e.getAttribute('aria-live'))) === 'off', 'the time left counts down without being read out');
    await page.close();
  }

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
