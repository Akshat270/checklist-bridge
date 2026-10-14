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
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})();
