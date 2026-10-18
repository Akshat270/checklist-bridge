// Renders the real panel (media/panel.js + panel.css) with sample checklists and saves the README images to docs/.
// Usage: npm run build && node scripts/screenshots.js   (needs Playwright's Chromium)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { ChecklistStore } = require(ROOT + '/dist/model.js');
const pw = require(ROOT + '/test/harness/playwright');
if (!pw) { console.error('Playwright is not installed.'); process.exit(1); }
const THEMES = require(ROOT + '/test/harness/themes');
const css = fs.readFileSync(ROOT + '/media/panel.css', 'utf8'), js = fs.readFileSync(ROOT + '/media/panel.js', 'utf8');
const OUT = path.join(ROOT, 'docs');
const S = 'screens';
const snap = (s, id) => JSON.parse(JSON.stringify(s.get(id)));
const tool = (s, name, args) => s.handleTool(S, {}, name, args);
const ids = (s) => s.all()[0].id;

function billing() {
  const s = new ChecklistStore();
  tool(s, 'checklist_add_tasks', { title: 'Add Stripe billing', tasks: [
    { text: 'Rotate the Stripe secret key you pasted in Slack', detail: 'Dashboard → Developers → API keys → Roll key. Then update STRIPE_SECRET_KEY in .env.local.', tags: ['urgent'] },
    { text: 'Create a product called "Pro" with a monthly price', group: 'Stripe dashboard' },
    { text: 'Copy the price id into .env.local', group: 'Stripe dashboard', command: 'STRIPE_PRICE_PRO=price_…', tags: ['quick'] },
    { text: 'Add the webhook endpoint', detail: 'Send checkout.session.completed to /api/stripe/webhook.', group: 'Stripe dashboard' },
    { text: 'Pay with the 4242 test card and check the plan changes', group: 'Check it works', tags: ['important'] },
    { text: 'Tell me which currencies you sell in', group: 'Check it works', tags: ['optional'] },
  ] });
  const id = ids(s);
  s.setDraft(id, 't2', { done: true }); s.share(id, 't2');
  s.setDraft(id, 't3', { done: true }); s.share(id, 't3');
  s.setDraft(id, 't6', { note: 'USD and EUR for now' });
  return snap(s, id);
}
function steps() {
  const s = new ChecklistStore();
  const t = (text, group, extra = {}) => ({ text, group, ...extra });
  tool(s, 'checklist_add_tasks', { title: 'Launch to production', phases: ['Set up', 'Test', 'Go live'], ordered_groups: ['Set up', 'Test', 'Go live'], tasks: [
    t('Create the production database', 'Set up', { detail: 'Supabase → New project → pick the region closest to your users.' }),
    t('Add the production env vars in Vercel', 'Set up', { command: 'vercel env add DATABASE_URL production' }),
    t('Run the migrations', 'Set up', { command: 'npx supabase db push' }),
    t('Sign up with a fresh email address', 'Test'),
    t('Pay with a test card', 'Test'),
    t('Point the domain at Vercel', 'Go live'),
    t('Switch Stripe to live keys', 'Go live'),
  ] });
  const id = ids(s);
  for (const x of ['t1', 't2']) { s.setDraft(id, x, { done: true }); s.share(id, x); }
  return snap(s, id);
}
function decide() {
  const s = new ChecklistStore();
  tool(s, 'checklist_add_tasks', { title: 'Launch subscriptions', tasks: [{ text: 'Add RAZORPAY_KEY_ID to .env.local', command: 'RAZORPAY_KEY_ID=rzp_test_…', group: 'Payments' }] });
  tool(s, 'checklist_ask', { questions: [
    { question: 'Which payment gateway should subscriptions use?', why: 'Decides the checkout page and how GST invoices are made. Billing work is on hold until then.', tags: ['urgent'], recommended: 'Razorpay', reason: 'Most of your sellers pay with UPI.',
      options: [{ label: 'Razorpay', summary: 'UPI Autopay and cards, GST-ready invoices', details: 'Subscriptions with UPI Autopay mandates. About 2% per transaction. Most Indian sellers already have an account.' }, { label: 'Stripe', summary: 'Better for sellers outside India', details: 'Strong docs and tooling, but UPI Autopay support is limited.' }, { label: 'Cashfree', summary: 'Lowest fees, smaller ecosystem' }] },
    { question: 'Show prices with or without GST?', options: ['With GST', 'Without GST'] },
    { question: 'How many marketplaces on the free plan?', options: ['1', '2', '3'] },
  ] });
  const id = ids(s);
  s.setAnswerDraft(id, 'q3', { picks: ['o2'], note: 'Free users mostly sell on Amazon and Flipkart' }); s.shareAnswer(id, 'q3');
  return snap(s, id);
}
function shared() {
  const s = new ChecklistStore();
  tool(s, 'checklist_add_tasks', { title: 'Fix the failing deploy', tasks: [
    { text: 'Open the Vercel build log and copy the first error', group: 'Find the cause' },
    { text: 'Check that NEXT_PUBLIC_API_URL is set for Production', group: 'Find the cause' },
    { text: 'Redeploy with the build cache cleared', group: 'Fix it', command: 'vercel --prod --force' },
    { text: 'Load the live site and open the dashboard page', group: 'Fix it' },
    { text: 'Confirm the old preview URL can be deleted', tags: ['optional'] },
  ] });
  const id = ids(s);
  s.setDraft(id, 't1', { done: true, note: 'Module not found: @/lib/env' }); s.share(id, 't1'); s.markSeen?.(id);
  s.setDraft(id, 't2', { done: true, note: 'It was missing. Added it.' });
  s.setDraft(id, 't3', { done: true });
  return snap(s, id);
}

const ROUTES = { waiting: false, channel: false, terminal: true };
async function page(b, theme, list, { w = 420, scale = 2, routes = ROUTES, open = [] } = {}) {
  const p = await b.newPage({ viewport: { width: w, height: 1200 }, deviceScaleFactor: scale });
  const body = theme === 'light' ? 'vscode-light' : 'vscode-dark';
  await p.setContent(`<!doctype html><html><head><style>html{${THEMES[theme]}}${css}</style></head><body class="${body}"><script>window.acquireVsCodeApi=()=>({postMessage(){},getState:()=>null,setState(){}});</script><script>${js}</script></body></html>`);
  await p.evaluate(([l, r]) => window.postMessage({ type: 'state', list: l, routes: r }, '*'), [list, routes]);
  await p.waitForTimeout(300);
  for (const sel of open) { await p.click(sel).catch(() => {}); await p.waitForTimeout(120); }
  await p.setViewportSize({ width: w, height: 300 });
  await p.waitForTimeout(100);
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(150);
  await p.mouse.move(2, 2);
  return p;
}
(async () => {
  const b = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const shoot = async (name, theme, list, opts) => {
    const p = await page(b, theme, list, opts);
    await p.screenshot({ path: path.join(OUT, name), fullPage: true });
    await p.close(); console.log('wrote docs/' + name);
  };
  await shoot('checklist-dark.png', 'dark', billing());
  await shoot('checklist-light.png', 'light', billing());
  await shoot('checklist-steps.png', 'dark', steps());
  await shoot('checklist-decide.png', 'dark', decide());
  await shoot('checklist-shared.png', 'dark', shared(), { open: ['text=Shared with Claude'] });
  await compose(b);
  await b.close();
})();

// Marketing images built from the panel screenshots above: docs/hero.png (also the GitHub social preview) and docs/how-it-works.png.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif";
const img = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, f)).toString('base64');
async function compose(b) {
  const base = `*{box-sizing:border-box;margin:0}body{font-family:${FONT};color:#e8e8f0;background:#14141f;overflow:hidden}`;
  const hero = `<style>${base}
  body{width:1280px;height:640px;background:radial-gradient(900px 500px at 85% 20%,#2c2a63 0%,transparent 60%),radial-gradient(700px 400px at 0% 100%,#173a2a 0%,transparent 60%),#14141f;position:relative}
  .l{position:absolute;left:72px;top:96px;width:600px}
  .k{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#9d9cff;font-weight:700}
  h1{font-size:60px;line-height:1.04;margin:18px 0 22px;font-weight:800;letter-spacing:-.02em}
  p{font-size:23px;line-height:1.4;color:#b9bad0}
  .pills{display:flex;gap:10px;margin-top:30px;flex-wrap:wrap}.pills span{border:1px solid #3a3a5a;background:#1d1d2e;border-radius:99px;padding:8px 16px;font-size:16px;color:#cfd0e6}
  .p{position:absolute;border-radius:14px;box-shadow:0 30px 70px #000a,0 0 0 1px #ffffff1a;overflow:hidden;width:262px}
  .p img{display:block;width:100%}
  </style><div class="l"><div class="k">For Claude Code in VS Code</div><h1>Stop hunting for manual steps in the chat.</h1><p>Every Claude chat gets its own checklist for the things only you can do, and the decisions you can make later.</p><div class="pills"><span>Tasks &amp; questions</span><span>Notes &amp; screenshots</span><span>Claude sees only what you share</span></div></div>
  <div class="p" style="left:700px;top:40px;transform:rotate(-2deg)"><img src="${img('checklist-steps.png')}"></div>
  <div class="p" style="left:985px;top:110px;transform:rotate(2deg)"><img src="${img('checklist-decide.png')}"></div>`;
  const how = `<style>${base}
  body{width:1280px;height:290px;background:#14141f;padding:34px 40px;position:relative}
  .row{display:flex;gap:18px;align-items:stretch}.c{flex:1;background:#1d1d2e;border:1px solid #33334f;border-radius:16px;padding:22px 22px 20px;position:relative}
  .n{width:34px;height:34px;border-radius:50%;background:#5b5bd6;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:17px}
  h3{font-size:22px;margin:14px 0 8px;font-weight:700}.c p{font-size:16px;line-height:1.45;color:#b4b5cc}
  .c:not(:last-child):after{content:'\\2192';position:absolute;right:-17px;top:50%;margin-top:-14px;font-size:22px;color:#7c7cf0;background:#14141f;border-radius:50%;z-index:2;width:16px;text-align:center}
  </style><div class="row">
  <div class="c"><div class="n">1</div><h3>Claude adds the tasks</h3><p>Keys to create, commands to run, pages to test. They land in your checklist, not in the chat.</p></div>
  <div class="c"><div class="n">2</div><h3>You work at your pace</h3><p>Tick things off, write a note, paste a screenshot. Claude keeps going meanwhile.</p></div>
  <div class="c"><div class="n">3</div><h3>You press Share</h3><p>One task at a time, or Share all. Change your mind and you can take it back.</p></div>
  <div class="c"><div class="n">4</div><h3>Claude reads what you shared</h3><p>Done, not done, your notes and screenshots. Nothing is assumed.</p></div></div>`;
  for (const [name, html, w, h] of [['hero.png', hero, 1280, 640], ['how-it-works.png', how, 1280, 290]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><html><body>${html}</body></html>`);
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(OUT, name) });
    await p.close(); console.log('wrote docs/' + name);
  }
}
