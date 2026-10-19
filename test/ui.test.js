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
  // Away: the time picker keeps what the user typed when the panel updates, and a time just ahead is not pushed a day too far.
  {
    const page = await b.newPage({ viewport: { width: 400, height: 1100 } });
    // The page's clock reads 10:04:40 on a fixed day, so "10:05" is 20 seconds ahead.
    const clock = 'const R=Date,off=new R(2026,0,15,10,4,40).getTime()-R.now();window.Date=class extends R{constructor(...a){a.length?super(...a):super(R.now()+off)}static now(){return R.now()+off}};';
    await page.setContent(`<!doctype html><html><head><style>html{${THEME}}${css}</style></head><body class="vscode-dark"><script>${clock}window.__out=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__out.push(m),getState:()=>null,setState(){}});</script><script>${js}</script></body></html>`);
    const push = () => page.evaluate((l) => window.postMessage({ type: 'state', list: l, routes: { waiting: false, channel: false, terminal: false } }, '*'), state(false, []));
    await push(); await page.waitForTimeout(200);
    await page.click('#away-btn');
    await page.fill('#away input[type=time]', '10:05');
    await page.focus('#away input[type=time]');
    await push(); await page.waitForTimeout(200); // Claude adds a task, or anything else changes
    check((await page.inputValue('#away input[type=time]')) === '10:05' && (await page.evaluate(() => document.activeElement.type)) === 'time', 'the time picker keeps the typed time and focus when the panel updates');
    await page.click('#away >> text=Set');
    const set = await page.evaluate(() => window.__out.find((m) => m.type === 'setAway'));
    const ahead = set && set.ms;
    check(set && ahead > 0 && ahead < 60_000 && set.label === '10:05 AM', `a time 20 seconds ahead is sent as a duration of 20 seconds, with the time as the user saw it (${ahead} ms, ${set && set.label})`);
    check(set && set.until === undefined, 'the panel sends how long, not a time of day from its own clock');
    await page.close();
  }
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
