const __ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const EXT = __ROOT;
const { ChecklistStore } = require(EXT + '/dist/model.js');
const pw = require('./harness/playwright');
if (!pw) { console.log('SKIP Playwright is not installed'); process.exit(0); }
const { chromium } = pw;
const THEMES = require('./harness/themes');
function build(stage) {
  const s = new ChecklistStore(), S = 'x';
  s.handleTool(S, {}, 'checklist_add_tasks', { title: 'Launch subscriptions for Unilytic sellers', tasks: [
    { text: 'Create a Razorpay test account and switch it to test mode', detail: 'dashboard.razorpay.com → Sign up', tags: ['urgent'], group: 'Payments' },
    { text: 'Add RAZORPAY_KEY_ID to .env.local', command: 'RAZORPAY_KEY_ID=rzp_test_aVeryLongKeyValueThatGoesOnAndOn1234567890', group: 'Payments' },
    { text: 'Check the pricing page on mobile', tags: ['quick', 'optional'] }] });
  s.handleTool(S, {}, 'checklist_ask', { questions: [
    { question: 'Which payment gateway should subscriptions use?', why: 'Decides checkout.', options: [{ label: 'Razorpay', summary: 'UPI Autopay, GST invoices', details: 'Long details text here.' }, 'Stripe'], recommended: 'Razorpay', reason: 'Most sellers pay with UPI.', tags: ['urgent'] },
    { question: 'Show prices with GST?', options: ['With GST', 'Without GST'], multi: true }] });
  const id = s.all()[0].id;
  if (stage >= 1) { s.setDraft(id, 't1', { done: true, note: 'Done, in test mode. A fairly long note to see wrapping behaviour in narrow panels.' }); s.share(id, 't1'); s.setAnswerDraft(id, 'q1', { picks: ['o1'], note: 'Go with UPI' }); s.shareAnswer(id, 'q1'); }
  if (stage >= 2) { s.handleTool(S, {}, 'checklist_read', {}); s.setDraft(id, 't2', { done: false, note: 'Could not find the key' }); s.share(id, 't2'); s.setAnswerDraft(id, 'q2', { picks: ['other'], other: 'Show both prices side by side' }); s.shareAnswer(id, 'q2'); }
  return JSON.parse(JSON.stringify(s.get(id)));
}
(async () => {
  const b = await chromium.launch();
  const css = fs.readFileSync(EXT + '/media/panel.css', 'utf8'), js = fs.readFileSync(EXT + '/media/panel.js', 'utf8');
  let bad = 0;
  for (const theme of ['mine', 'light']) for (const w of [300, 360, 431, 600]) for (const stage of [0, 1, 2]) for (const routes of [{ waiting: false, channel: false, terminal: false }, { waiting: false, channel: false, terminal: true }, { waiting: true, channel: false, terminal: false }]) {
    const page = await b.newPage({ viewport: { width: w, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.setContent(`<!doctype html><html><head><style>html{${THEMES[theme]}}${css}</style></head><body class="vscode-${theme === 'light' ? 'light' : 'dark'}"><script>window.acquireVsCodeApi=()=>({postMessage(){},getState:()=>null,setState(){}});</script><script>${js}</script></body></html>`);
    await page.evaluate(([l, r]) => window.postMessage({ type: 'state', list: l, routes: r }, '*'), [build(stage), routes]);
    await page.waitForTimeout(150);
    // open the Shared section and every collapsed row
    for (const t of await page.$$('text=Shared with Claude')) await t.click().catch(() => {});
    await page.waitForTimeout(80);
    for (const r of await page.$$('.task:not(.open) .row')) { await r.click().catch(() => {}); await page.waitForTimeout(40); }
    for (const d of await page.$$('summary')) await d.click().catch(() => {});
    await page.waitForTimeout(120);
    const res = await page.evaluate(() => {
      const W = document.documentElement.clientWidth, out = [];
      for (const card of document.querySelectorAll('.task, .qcard, .sendbar')) {
        const cr = card.getBoundingClientRect();
        for (const e of card.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && r.right > cr.right + 1) out.push((card.id || card.className) + ' > ' + (typeof e.className === 'string' ? e.className : e.tagName) + ' +' + Math.round(r.right - cr.right)); }
      }
      return { scroll: document.documentElement.scrollWidth - W, out: [...new Set(out)].slice(0, 6) };
    });
    if (res.scroll > 0 || res.out.length || errs.length) { bad++; console.log(theme, w, 'stage', stage, JSON.stringify(routes), JSON.stringify(res), errs); }
    
    await page.close();
  }
  console.log(bad ? `FAIL ${bad} layouts with overflow` : 'PASS no overflow in 72 layouts');
  process.exitCode = bad ? 1 : 0;
  await b.close();
})();
