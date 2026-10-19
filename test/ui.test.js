const __ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs'), path = require('path');
const EXT = __ROOT;
const { ChecklistStore } = require(EXT + '/dist/model.js');
const pw = require('./harness/playwright');
if (!pw) { console.log('SKIP Playwright is not installed'); process.exit(0); }
const { chromium } = pw;
const THEME = require('./harness/themes').dark;
let failed = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
function state(shareTask, answers) {
  const s = new ChecklistStore(), S = 'x';
  s.handleTool(S, {}, 'checklist_add_tasks', { title: 'T', tasks: ['One', 'Two'] });
  s.handleTool(S, {}, 'checklist_ask', { questions: [{ question: 'Q1?', options: ['A', 'B'] }, { question: 'Q2?', options: ['C', 'D'] }] });
  const id = s.all()[0].id;
  if (shareTask) { s.setDraft(id, 't1', { done: true }); s.share(id, 't1'); }
  for (const q of answers) { s.setAnswerDraft(id, q, { picks: ['o1'] }); s.shareAnswer(id, q); }
  return JSON.parse(JSON.stringify(s.get(id)));
}
(async () => {
  const b = await chromium.launch();
  const css = fs.readFileSync(EXT + '/media/panel.css', 'utf8'), js = fs.readFileSync(EXT + '/media/panel.js', 'utf8');
  const cases = [
    ['task + answer, idle panel', state(true, ['q1']), { waiting: false, channel: false, terminal: false }, 1, 'bar', 'shot-task-and-answer.png'],
    ['one answer only, terminal', state(false, ['q1']), { waiting: false, channel: false, terminal: true }, 1, 'card', 'shot-one-answer.png'],
    ['two answers, idle panel', state(false, ['q1', 'q2']), { waiting: false, channel: false, terminal: false }, 1, 'bar'],
    ['one task only', state(true, []), { waiting: false, channel: false, terminal: true }, 1, 'bar'],
    ['Claude waiting', state(true, ['q1']), { waiting: true, channel: false, terminal: false }, 0, null],
  ];
  for (const [name, list, routes, n, where, shot] of cases) {
    const page = await b.newPage({ viewport: { width: 400, height: 1100 }, deviceScaleFactor: 2 });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.setContent(`<!doctype html><html><head><style>html{${THEME}}${css}</style></head><body class="vscode-dark"><script>window.acquireVsCodeApi=()=>({postMessage(){},getState:()=>null,setState(){}});</script><script>${js}</script></body></html>`);
    await page.evaluate(([l, r]) => window.postMessage({ type: 'state', list: l, routes: r }, '*'), [list, routes]);
    await page.waitForTimeout(300);
    const btns = await page.$$eval('button', (bs) => bs.filter((x) => /Send now|Copy for chat/.test(x.textContent)).map((x) => (x.closest('.sendbar') ? 'bar' : x.closest('.qcard') ? 'card' : 'other')));
    const bar = await page.$eval('.sendbar', (e) => e.textContent).catch(() => '');
    check(btns.length === n && (n === 0 || btns[0] === where) && !errs.length, `${name}: ${btns.length} control(s) ${btns.join(',')} ${bar ? '| bar: "' + bar + '"' : ''}`);
    if (shot && process.env.SHOTS) { await page.mouse.move(2, 2); await page.screenshot({ path: path.join(process.env.SHOTS, shot), fullPage: true }); }
    await page.close();
  }
  // Every task and question shows the id Claude uses; clicking it copies the id without opening the row.
  {
    const page = await b.newPage({ viewport: { width: 400, height: 1100 } });
    await page.setContent(`<!doctype html><html><head><style>html{${THEME}}${css}</style></head><body class="vscode-dark"><script>window.__out=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__out.push(m),getState:()=>null,setState(){}});</script><script>${js}</script></body></html>`);
    await page.evaluate((l) => window.postMessage({ type: 'state', list: l, routes: { waiting: false, channel: false, terminal: false } }, '*'), state(true, ['q1']));
    await page.waitForTimeout(300);
    for (const t of await page.$$('text=Shared with Claude')) await t.click().catch(() => {});
    await page.waitForTimeout(150);
    const shown = await page.$$eval('.item-id', (xs) => xs.map((x) => x.textContent).sort().join(' '));
    check(shown === 'q1 q2 t1 t2', `every task and question shows its id (${shown})`);
    const isOpen = () => page.$eval('#task-t2', (e) => e.classList.contains('open'));
    const before = await isOpen();
    await page.click('#task-t2 .item-id'); await page.waitForTimeout(100);
    const out = await page.evaluate(() => window.__out.filter((m) => m.type === 'copy'));
    check(out.length === 1 && out[0].text === 't2' && (await isOpen()) === before, 'clicking an id copies it, without opening or closing the task');
    await page.close();
  }
  // Away: a moon in the header opens a picker; a time is only set after a yes.
  {
    const page = await b.newPage({ viewport: { width: 400, height: 1100 } });
    // The page's clock reads 10:04:40 on a fixed day, so "10:05" is 20 seconds ahead.
    const clock = 'const R=Date,off=new R(2026,0,15,10,4,40).getTime()-R.now();window.Date=class extends R{constructor(...a){a.length?super(...a):super(R.now()+off)}static now(){return R.now()+off}};';
    await page.setContent(`<!doctype html><html><head><style>html{${THEME}}${css}</style></head><body class="vscode-dark"><script>${clock}window.__out=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__out.push(m),getState:()=>null,setState(){}});</script><script>${js}</script></body></html>`);
    const send = (extra) => page.evaluate(([l, e]) => window.postMessage({ type: 'state', list: Object.assign(l, e), routes: { waiting: false, channel: false, terminal: false } }, '*'), [state(false, []), extra || {}]);
    const posted = (t) => page.evaluate((t) => window.__out.filter((m) => m.type === t), t);
    const visible = (sel) => page.$eval(sel, (e) => !!e.offsetParent && getComputedStyle(e).visibility !== 'hidden').catch(() => false);
    await send(); await page.waitForTimeout(200);
    check(await page.$eval('.tools #away-btn + #hide', () => true).catch(() => false), 'the away control is an icon in the header, next to hide and close');
    check(!(await visible('.away-card')), 'nothing about away takes room until it is opened');

    await page.click('#away-btn'); await page.waitForTimeout(450);
    check((await page.$$('.away-chip')).length === 4 && (await visible('.away-card')), 'the moon opens a picker with four times');
    const chipH = await page.$eval('.away-chip', (e) => e.getBoundingClientRect().height);
    check(chipH >= 44 && /^\d{1,2}:\d\d [AP]M$/.test(await page.$eval('.away-chip-t', (e) => e.textContent)), `the time buttons are whole (${Math.round(chipH)} px high) and show a plain time`);
    check(await page.evaluate(() => document.activeElement === document.body || document.activeElement.id !== 'away-time'), 'opening the picker does not select the hour');
    await page.fill('#away-time', '10:05');
    await page.focus('#away-time');
    await send(); await page.waitForTimeout(200); // Claude adds a task, or anything else changes
    check((await page.inputValue('#away-time')) === '10:05' && (await page.evaluate(() => document.activeElement.type)) === 'time', 'the time picker keeps the typed time and focus when the panel updates');

    await page.click('.away-chip >> text=2 hours'); await page.waitForTimeout(450);
    check((await posted('setAway')).length === 0 && /Away until 12:04 PM\?/.test(await page.$eval('.away-card', (e) => e.textContent)), 'picking a time asks first and sets nothing yet');
    check(/Write to Claude/.test(await page.$eval('.away-card', (e) => e.textContent)), 'a long break says how to carry on');
    await page.click('text=Not now'); await page.waitForTimeout(500);
    check((await posted('setAway')).length === 0 && !(await visible('.away-card')), 'Not now closes it without setting anything');

    // A time 20 seconds ahead is a duration of 20 seconds, with the time as the user saw it.
    await page.click('#away-btn'); await page.waitForTimeout(450);
    await page.fill('#away-time', '10:05');
    await page.click('.away-card >> text=Set'); await page.waitForTimeout(450);
    await page.click('.away-card >> text=Yes');
    const set = (await posted('setAway'))[0];
    check(set && set.ms > 0 && set.ms < 60_000 && set.label === '10:05 AM' && set.until === undefined, `yes sends how long, not a time of day from the panel's clock (${set && set.ms} ms, ${set && set.label})`);

    // The window says the user is away: the away card shows, with I'm back.
    await send({ away: true, awayUntil: Date.now() + 7200_000, awayLabel: '12:04 PM', awayLeft: 7200_000, awayMs: 7200_000 });
    await page.waitForTimeout(450);
    const on = await page.$eval('.away-card', (e) => e.textContent);
    check(/Away until 12:04 PM/.test(on) && /2 h left/.test(on) && /I’m back/.test(on) && !(await visible('.away-chip')), 'while away: the end time, the time left and I’m back');
    // Already away: changing the time asks again, and the new time replaces the old one.
    await page.click('.away-card >> text=Change'); await page.waitForTimeout(450);
    await page.click('.away-chip >> text=30 min'); await page.waitForTimeout(450);
    check(/Away until 10:34 AM\?/.test(await page.$eval('.away-card', (e) => e.textContent)) && (await posted('setAway')).length === 1, 'while away, picking a new time asks again and sets nothing yet');
    await page.click('.away-card >> text=Yes'); await page.waitForTimeout(100);
    const second = (await posted('setAway'))[1];
    check(second && second.ms === 1800_000 && second.label === '10:34 AM', `yes sends the new time (${second && second.ms} ms)`);
    await send({ away: true, awayUntil: Date.now() + 1800_000, awayLabel: '10:34 AM', awayLeft: 1800_000, awayMs: 1800_000 });
    await page.waitForTimeout(450);
    const pageNow0 = await page.evaluate(() => Date.now()); // the page's clock is set to a fixed day
    const changed = await page.$eval('.away-card', (e) => e.textContent);
    check(/Away until 10:34 AM/.test(changed) && /30 min left/.test(changed), 'the away card then shows the new time and time left');
    // The bar shows how much of the away is left, and +30 min stays away longer.
    await send({ away: true, awayUntil: pageNow0 + 1800_000, awayLabel: '10:34 AM', awayLeft: 1800_000, awayMs: 7200_000 });
    await page.waitForTimeout(500);
    check((await page.$eval('#away-fill', (e) => e.style.width)) === '25%', 'the bar shows how much of the away is left (30 min of 2 h)');
    const before = await posted('setAway');
    await page.click('.away-card >> text=+30 min'); await page.waitForTimeout(100);
    const more = (await posted('setAway'))[before.length];
    check(more && more.ms > 3_500_000 && more.ms <= 3600_000 && more.label === '11:04 AM', `+30 min asks for the time left plus 30 minutes (${more && more.ms} ms, ${more && more.label})`);
    await send({ away: true, awayUntil: pageNow0 + 3600_000, awayLabel: '11:04 AM', awayLeft: 3600_000, awayMs: 3600_000 });
    await page.waitForTimeout(450);
    const longer = await page.$eval('.away-card', (e) => e.textContent);
    check(/Away until 11:04 AM/.test(longer) && /1 h left/.test(longer), 'the card then shows the new end time');
    // An older window may not send the time left: work it out from the end time instead of saying "1 min".
    const pageNow = await page.evaluate(() => Date.now()); // the page's clock is set to a fixed day
    await send({ away: true, awayUntil: pageNow + 5400_000, awayLabel: '11:34 AM', awayLeft: undefined, awayMs: undefined });
    await page.waitForTimeout(450);
    check(/1 h 30 min left/.test(await page.$eval('.away-card', (e) => e.textContent)), 'without a time left from the window, it is worked out from the end time');
    await page.click('text=I’m back'); await page.waitForTimeout(450);
    check((await posted('endAway')).length === 1 && /Welcome back/.test(await page.$eval('.away-card', (e) => e.textContent)), 'I’m back tells the window and says welcome back');
    await send(); // the window now says: not away
    await page.click('text=Got it'); await page.waitForTimeout(500);
    check(!(await visible('.away-card')), 'Got it closes it');
    await page.close();
  }
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
