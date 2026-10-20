// Renders the Checklist Bridge promo frame by frame: the real panel (media/panel.js + panel.css) driven by the real
// ChecklistStore, inside a drawn VS Code window, with a mock Claude chat, captions, camera moves and an end card.
// Usage (from the repo root, after `npm run build`): node promo/video/render.js vertical|square [--preview t1,t2,...]
// Writes build/video-<format>.mp4 (no sound) and build/events.json (the sound cues for audio.py).
// --preview writes a few JPEG frames to build/ instead, which is much faster for checking a change.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const REPO = path.resolve(__dirname, '../..');
const { ChecklistStore } = require(REPO + '/dist/model.js');
const { chromium } = require(REPO + '/node_modules/playwright');
const THEMES = require(REPO + '/test/harness/themes');
const HERE = __dirname;
const OUT = path.join(HERE, 'build');
fs.mkdirSync(OUT, { recursive: true });

const FORMAT = process.argv[2] || 'vertical';
const PREVIEW = process.argv.includes('--preview') ? process.argv[process.argv.indexOf('--preview') + 1].split(',').map(Number) : null;
const FPS = 30, DURATION = 44.0, END_AT = 34.67;
const LAYOUTS = {
  vertical: { W: 540, H: 960, VX: 20, VY: 262, VW: 500, CAP_Y: 74, CAP_SIZE: 34, SUB_SIZE: 18 },
  square: { W: 540, H: 540, VX: 20, VY: 146, VW: 500, CAP_Y: 18, CAP_SIZE: 25, SUB_SIZE: 14 },
};
const L = LAYOUTS[FORMAT];
const PANEL_X = 480, PANEL_Y = 66; // where the panel iframe sits in world coords

/* ------------------------------------------------------------------ script ------------------------------------------------------------------ */
const CAPTIONS = [
  { a: 0.25, b: 3.85, html: 'Wait… what did Claude<br>ask me to do?' },
  { a: 4.05, b: 7.7, html: 'Manual steps get<br><span class="hl-warn">lost in the chat.</span>' },
  { a: 8.15, b: 10.05, html: 'There’s a<br><span class="hl">better way.</span>' },
  { a: 10.35, b: 13.2, html: '<span class="hl">Checklist Bridge</span> gives every<br>Claude chat its own checklist.' },
  { a: 13.4, b: 18.5, html: 'The next task is<br>always on top.', sub: 'Urgent ones jump the queue and turn red.', subAt: 14.6 },
  { a: 18.75, b: 23.75, html: 'Tick it. Add a note.<br>Press <span class="hl">Share</span>.', sub: 'Paste a screenshot if it helps.', subAt: 21.9 },
  { a: 23.95, b: 26.5, html: 'Claude only sees<br>what you <span class="hl">share</span>.', sub: 'It never assumes you did something you didn’t.', subAt: 24.6 },
  { a: 26.75, b: 34.4, html: 'Decide later.<br><span class="hl">Claude keeps working.</span>', sub: 'Questions wait in Decide with Claude’s pick.', subAt: 28.2 },
];
const CAMERA = [
  [0, 'chat', 0],
  [7.6, 'chatEnd', 0.45],
  [9.9, 'wide', 0.85],
  [12.0, 'panel', 0.95],
  [24.55, 'chatEnd', 0.8],
  [27.85, 'panel', 0.9],
  [31.85, 'chatEnd', 0.8],
];
if (FORMAT === 'square') {
  // Less height to show, so the camera follows the work down the panel.
  const P = (y) => ({ x: 480, y, w: 420 });
  for (const k of CAMERA) if (k[0] === 27.85) k[1] = P(200);
  CAMERA.push([16.9, P(150), 0.6], [21.55, P(250), 0.5], [30.1, P(320), 0.55]);
  CAMERA.sort((a, b) => a[0] - b[0]);
}
const CHAT = [
  { at: 8.9, kind: 'user', text: 'Add Stripe billing with a Pro plan' },
  { at: 9.15, kind: 'text', dur: 1.0, text: 'I’ll build the checkout and the webhook. A few steps need you in the Stripe dashboard, so I’ve put them on your checklist.' },
  { at: 10.0, kind: 'tool', wait: 0.35, name: 'checklist_add_tasks', args: '“Add Stripe billing”', result: 'Added 5 tasks. Not waiting for you.' },
  { at: 11.0, kind: 'text', dur: 0.8, text: 'Meanwhile, I’m starting on the checkout page.' },
  { at: 14.3, kind: 'tool', wait: 0.3, name: 'checklist_add_tasks', args: 'urgent', result: 'Added t6: Roll the key you pasted in Slack' },
  { at: 24.95, kind: 'tool', wait: 0.45, name: 'checklist_read', args: '', result: 't6 done: “Rolled it. New key is in .env.local” + 1 screenshot' },
  { at: 25.6, kind: 'text', dur: 0.8, text: 'Thanks. The new key works. On to the webhook.' },
  { at: 26.8, kind: 'tool', wait: 0.35, name: 'checklist_ask', args: '“Free trial”', result: 'Asked q1 in Decide. Not waiting for an answer.' },
  { at: 27.3, kind: 'text', dur: 0.6, text: 'While you decide, I’ll write the webhook handler.' },
  { at: 28.1, kind: 'edit', dur: 5.4, file: 'app/api/stripe/webhook/route.ts', lines: [
    'export async function POST(req: Request) {',
    '  const sig = req.headers.get("stripe-signature")!;',
    '  const body = await req.text();',
    '  const event = stripe.webhooks.constructEvent(',
    '    body, sig, process.env.STRIPE_WEBHOOK_SECRET!);',
    '  if (event.type === "checkout.session.completed") {',
    '    const s = event.data.object;',
    '    await db.user.update({',
    '      where: { id: s.client_reference_id! },',
    '      data: { plan: "pro", trialEndsAt: in14Days() },',
    '    });',
    '  }',
    '  return new Response("ok");',
    '}',
  ] },
  { at: 33.55, kind: 'tool', wait: 0.4, name: 'checklist_read', args: '', result: 'q1: No card for 14 days' },
];
const INPUT = { a: 8.2, b: 8.9, text: 'Add Stripe billing with a Pro plan' };
const SEARCH = 'Checklist Bridge';

/* ------------------------------------------------------------------ page ------------------------------------------------------------------ */
const css = fs.readFileSync(REPO + '/media/panel.css', 'utf8');
const pjs = fs.readFileSync(REPO + '/media/panel.js', 'utf8');
const theme = THEMES.dark.replace(/--vscode-font-family:[^;]+/, "--vscode-font-family:Inter,system-ui,sans-serif").replace(/--vscode-editor-font-family:[^;]+/, "--vscode-editor-font-family:'JetBrains Mono',monospace");
const panelDoc = `<!doctype html><html><head><style>html{${theme}}${css}
html,body{overflow:hidden} ::-webkit-scrollbar{display:none}</style></head><body class="vscode-dark">
<script>window.__out=[];window.acquireVsCodeApi=()=>({postMessage(m){window.__out.push(m)},getState:()=>window.__ui||null,setState(s){window.__ui=s}});</script>
<script>${pjs}</script></body></html>`;
const b64 = (f) => fs.readFileSync(f).toString('base64');
const icon = 'data:image/png;base64,' + b64(REPO + '/media/icon.png');
const tabIcon = 'data:image/svg+xml;base64,' + b64(REPO + '/media/tab.svg');

const OLD_CHAT = `
<div class="m user">The login page breaks on Safari, can you look?</div>
<div class="m text">Found it. The date input uses a format Safari doesn’t parse. I switched it to an ISO string and added a test. Login works in Safari, Chrome and Firefox now.</div>
<div class="m tool"><div><span class="dot ok"></span><b>Edit</b> <span class="muted">app/login/page.tsx</span></div></div>
<div class="m user">Nice. Now let’s add payments</div>
<div class="m text">Sure. I’ll use Stripe Checkout with a monthly Pro plan. Here’s the plan: a pricing page, a checkout route, a webhook that upgrades the user, and a billing portal link in settings.</div>
<div class="m tool"><div><span class="dot ok"></span><b>Write</b> <span class="muted">app/pricing/page.tsx</span></div></div>
<div class="m tool"><div><span class="dot ok"></span><b>Write</b> <span class="muted">app/api/checkout/route.ts</span></div></div>
<div class="m text" id="buried">The checkout route is ready. Before it works end to end, a few things need doing on your side. First, <mark data-chip="Create a Stripe API key">create a secret key in the Stripe dashboard</mark> under Developers → API keys, then <mark data-chip="Add it to .env.local">add it to .env.local as STRIPE_SECRET_KEY</mark>. When the webhook route is deployed you’ll also need to <mark data-chip="Add the webhook endpoint">add the webhook endpoint</mark> and copy its signing secret. Finally, <mark data-chip="Test checkout with the 4242 card">test checkout with the 4242 card</mark> and check the plan changes.</div>
<div class="m user">ok. also the navbar looks off on mobile</div>
<div class="m text">The menu button was hidden behind the logo at small widths. I moved it into a flex row and gave the logo a max width.</div>
<div class="m tool"><div><span class="dot ok"></span><b>Edit</b> <span class="muted">components/Navbar.tsx</span></div></div>
<div class="m user">and can you make the footer links grey</div>
<div class="m text">Done. Footer links use the muted text colour now, and turn white on hover.</div>
<div class="m tool"><div><span class="dot ok"></span><b>Edit</b> <span class="muted">components/Footer.tsx</span></div></div>
<div class="m user">the build fails on vercel</div>
<div class="m text">The build needs NEXT_PUBLIC_API_URL, which isn’t set for Production. Add it in Vercel → Settings → Environment Variables and redeploy. I also made the error message say which variable is missing.</div>
<div class="m tool"><div><span class="dot ok"></span><b>Edit</b> <span class="muted">lib/env.ts</span></div></div>
<div class="m user">rename “Pro” to “Pro plan” everywhere</div>
<div class="m text">Renamed in the pricing page, the checkout route and the emails. 6 files changed.</div>
<div class="m tool"><div><span class="dot ok"></span><b>Edit</b> <span class="muted">6 files</span></div></div>
<div class="m user">why does checkout say “No such price”?</div>
<div class="m text">Stripe can’t find the price id. That usually means the key and the price are from different modes, test and live. Did you do the steps I mentioned earlier?</div>
<div class="m user">which steps??</div>`;

const CODE = `<span class="k">import</span> Stripe <span class="k">from</span> <span class="s">"stripe"</span>;
<span class="k">import</span> { db } <span class="k">from</span> <span class="s">"@/lib/db"</span>;

<span class="k">export const</span> stripe = <span class="k">new</span> Stripe(
  process.env.STRIPE_SECRET_KEY!
);

<span class="c">// Pro plan, billed monthly</span>
<span class="k">export async function</span> <span class="f">createCheckout</span>(userId: <span class="t">string</span>) {
  <span class="k">return</span> stripe.checkout.sessions.<span class="f">create</span>({
    mode: <span class="s">"subscription"</span>,
    line_items: [{ price: PRICE_PRO, quantity: 1 }],
    client_reference_id: userId,
    success_url: <span class="s">\`\${BASE}/billing?ok=1\`</span>,
  });
}`;

const stageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${L.W}px;height:${L.H}px;overflow:hidden;background:#101018;font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
#bg{position:absolute;inset:0;background:radial-gradient(520px 420px at 80% 18%,#2d2a6b 0%,transparent 62%),radial-gradient(520px 460px at 5% 92%,#173a2a 0%,transparent 60%),#12121b;background-size:140% 140%}
#grain{position:absolute;inset:0;opacity:.05;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence baseFrequency='.9' numOctaves='2'/></filter><rect width='160' height='160' filter='url(%23n)'/></svg>")}
#world-wrap{position:absolute;inset:0;overflow:hidden;-webkit-mask-image:linear-gradient(transparent ${L.VY - (FORMAT === 'square' ? 22 : 34)}px,#000 ${L.VY + 6}px)}
#world{position:absolute;left:0;top:0;width:900px;height:1180px;transform-origin:0 0}
.win{position:absolute;inset:0;border-radius:14px;overflow:hidden;background:#181818;box-shadow:0 40px 90px #000c,0 0 0 1px #ffffff1c}
.title{height:32px;background:#1f1f1f;border-bottom:1px solid #2b2b2b;display:flex;align-items:center;padding:0 14px;gap:8px;color:#9d9d9d;font-size:12.5px}
.title i{width:12px;height:12px;border-radius:50%;display:block}.title span{flex:1;text-align:center;margin-right:52px}
.act{position:absolute;left:0;top:32px;bottom:0;width:44px;background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;align-items:center;padding-top:12px;gap:18px}
.act b{width:20px;height:20px;border:1.6px solid #6b6b6b;border-radius:5px;display:block}.act b.on{border-color:#d0d0d0}
.chat{position:absolute;left:44px;top:32px;width:436px;bottom:0;background:#1b1b1b;border-right:1px solid #2b2b2b;overflow:hidden}
.chat-head{height:34px;display:flex;align-items:center;padding:0 16px;font-size:11.5px;letter-spacing:.08em;color:#9d9d9d;font-weight:600;border-bottom:1px solid #2b2b2b;background:#1b1b1b;position:relative;z-index:2}
.chat-body{position:absolute;left:0;right:0;top:34px;bottom:96px;overflow:hidden}
#old{position:absolute;left:0;right:0;top:0;padding:16px}
#log{position:absolute;left:0;right:0;bottom:0;padding:16px;display:flex;flex-direction:column;gap:12px}
#old .m{margin-bottom:12px}
.m{font-size:14px;line-height:1.5;color:#dcdcdc}
.m.user{background:#2a2a2e;border:1px solid #3a3a40;border-radius:10px;padding:9px 12px;color:#f0f0f0;align-self:flex-start}
.m.tool{font-size:13px;color:#cfcfcf}.m.tool b{font-weight:600;color:#e8e8e8}.muted{color:#8c8c8c}
.m.tool .res{color:#9d9d9d;padding-left:15px;margin-top:2px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:8px;vertical-align:1px;background:#3fb950}.dot.run{background:#e3b341}.dot.dim{opacity:.35}
.diff{margin:6px 0 0 15px;border:1px solid #2f3a31;border-radius:8px;overflow:hidden;font:11.5px/1.55 'JetBrains Mono',monospace;background:#16201a}
.diff .add{color:#b7e4c0;padding:0 8px;white-space:pre;background:#1c2e21}.diff i{font-style:normal;color:#3fb950;margin-right:6px}
mark{background:linear-gradient(#e3b341,#e3b341) no-repeat 0 0/0% 100%;color:inherit;border-radius:3px;padding:0 1px}
.caret{display:inline-block;width:7px;height:15px;background:#c8c8c8;vertical-align:-2px;margin-left:2px}
.input{position:absolute;left:12px;right:12px;bottom:14px;height:70px;border:1px solid #3a3a40;border-radius:12px;background:#222226;padding:10px 12px;font-size:14px;color:#eee}
.input .ph{color:#777}
.input .send{position:absolute;right:10px;bottom:9px;width:26px;height:26px;border-radius:8px;background:#3a3a40}
.right{position:absolute;left:480px;top:32px;width:420px;bottom:0;background:#1f1f1f}
.tabs{height:34px;display:flex;background:#181818;border-bottom:1px solid #2b2b2b}
.tab{display:flex;align-items:center;gap:7px;padding:0 14px;font-size:12.5px;color:#8c8c8c;border-right:1px solid #2b2b2b}
.tab.active{background:#1f1f1f;color:#e8e8e8;box-shadow:inset 0 1px 0 #8b8ff9}
.tab img{width:14px;height:14px}
#editor{position:absolute;left:0;right:0;top:34px;bottom:0;padding:14px 0 0 0;font:12.5px/1.6 'JetBrains Mono',monospace;color:#d4d4d4;white-space:pre}
#editor .ln{display:inline-block;width:38px;text-align:right;color:#5a5a5a;margin-right:14px}
.k{color:#c586c0}.s{color:#ce9178}.c{color:#6a9955}.f{color:#dcdcaa}.t{color:#4ec9b0}
#panel{position:absolute;left:0;top:34px;width:420px;height:1114px;border:0;background:#1f1f1f}
#caps{position:absolute;left:0;right:0;top:${L.CAP_Y}px;text-align:center;padding:0 22px}
.cap{position:absolute;left:22px;right:22px;top:0}
.cap-main{font-size:${L.CAP_SIZE}px;line-height:1.13;font-weight:800;letter-spacing:-.022em;color:#fff;text-shadow:0 2px 24px #0008}
.cap-sub{margin-top:${Math.round(L.SUB_SIZE * 0.7)}px;font-size:${L.SUB_SIZE}px;line-height:1.35;color:#c4c5dc;font-weight:500}
.hl{color:#a9acff}.hl-warn{color:#ffb4a8}
#chips{position:absolute;inset:0;pointer-events:none}
.chip-fly{position:absolute;padding:9px 14px;border-radius:12px;background:#2a2a3a;border:1px solid #ffffff22;color:#fff;font-weight:650;font-size:15px;white-space:nowrap;box-shadow:0 14px 40px #0009}
#cursor{position:absolute;left:0;top:0;width:22px;height:22px;transform-origin:2px 2px;filter:drop-shadow(0 3px 6px #0009);z-index:10}
#ripple{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;border:2.5px solid #a9acff;background:#8b8ff933;z-index:9}
#keycap{position:absolute;left:0;top:0;padding:6px 12px;border-radius:10px;background:#f2f2f7;color:#16161e;font-weight:800;font-size:15px;box-shadow:0 6px 0 #9a9ab0,0 14px 30px #000a;letter-spacing:.02em;z-index:11}
#notify{position:absolute;left:50%;top:${FORMAT === 'square' ? L.VY + 12 : L.VY - 50}px;padding:9px 16px 9px 12px;border-radius:99px;background:#2b1a1a;border:1px solid #ff6a5577;color:#ffd9d2;font-size:14.5px;font-weight:600;white-space:nowrap;box-shadow:0 12px 30px #000a;display:flex;align-items:center;gap:8px}
#notify i{width:9px;height:9px;border-radius:50%;background:#ff6a55;display:block;box-shadow:0 0 0 4px #ff6a5533}
#vignette{position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(transparent,#12121bee);pointer-events:none}
#end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#fff;padding:0 30px}
#end .icon{width:${FORMAT === 'square' ? 52 : 92}px;height:${FORMAT === 'square' ? 52 : 92}px;border-radius:${FORMAT === 'square' ? 14 : 22}px;box-shadow:0 20px 60px #5e63e688,0 0 0 1px #ffffff22}
#end h1{font-size:${FORMAT === 'square' ? 28 : 42}px;font-weight:800;letter-spacing:-.025em;margin-top:${FORMAT === 'square' ? 8 : 18}px}
#end .tag{font-size:${FORMAT === 'square' ? 14.5 : 19}px;color:#c4c5dc;margin-top:${FORMAT === 'square' ? 4 : 8}px;line-height:1.35;font-weight:500}
#end .pills{display:${FORMAT === 'square' ? 'none' : 'flex'};gap:8px;justify-content:center;flex-wrap:wrap;margin-top:${FORMAT === 'square' ? 14 : 22}px}
#end .pills span{border:1px solid #3a3a5a;background:#1d1d2ecc;border-radius:99px;padding:6px 13px;font-size:13.5px;color:#d6d7ee;font-weight:600}
.steps{margin-top:${FORMAT === 'square' ? 14 : 30}px;width:100%;max-width:440px;text-align:left}
.steps h2{font-size:${FORMAT === 'square' ? 14.5 : 17}px;font-weight:750;color:#fff;margin-bottom:${FORMAT === 'square' ? 6 : 10}px;letter-spacing:-.01em}
.step{display:flex;align-items:center;gap:10px;padding:${FORMAT === 'square' ? 3 : 5}px 8px;border-radius:9px;font-size:${FORMAT === 'square' ? 13 : 15}px;color:#c4c5dc;font-weight:500}
.step b{flex:none;width:${FORMAT === 'square' ? 20 : 23}px;height:${FORMAT === 'square' ? 20 : 23}px;border-radius:50%;background:#2b2b44;color:#c9cbff;display:grid;place-items:center;font-size:${FORMAT === 'square' ? 11.5 : 13}px;font-weight:800}
.step.on{background:#5e63e62e;color:#fff}.step.on b{background:#5e63e6;color:#fff}
kbd{font:600 ${FORMAT === 'square' ? 11.5 : 13}px/1 Inter,sans-serif;border:1px solid #4a4a66;border-bottom-width:2px;border-radius:5px;padding:2px 5px;color:#fff;background:#24243a}
.search{margin-top:${FORMAT === 'square' ? 10 : 16}px;width:100%;max-width:440px;background:#1f1f1f;border:1px solid #3c3c3c;border-radius:12px;overflow:hidden;text-align:left;box-shadow:0 20px 50px #000a}
.search .bar{display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid #2f2f2f;font-size:15px;color:#e8e8e8}
.search .bar .q{flex:1;border:1px solid #0078d4;border-radius:6px;padding:6px 9px;background:#2a2a2a;min-height:33px}
#search-caret{display:inline-block;width:1.5px;height:17px;background:#fff;vertical-align:-3px;margin-left:1px}
.search .label{font-size:11px;letter-spacing:.08em;color:#9d9d9d;font-weight:700}
#result{display:flex;gap:12px;padding:12px 14px;align-items:center}
#result img{width:42px;height:42px;border-radius:9px}
#result .n{font-weight:700;font-size:15px}#result .d{font-size:12.5px;color:#b8b8b8;margin-top:2px}#result .p{font-size:12px;color:#8f8f8f;margin-top:2px;font-weight:600}
#result .btn{margin-left:auto;flex:none;background:#0078d4;color:#fff;font-size:13px;font-weight:600;padding:6px 12px;border-radius:6px}
.alt{margin-top:${FORMAT === 'square' ? 9 : 16}px;font-size:${FORMAT === 'square' ? 12 : 14}px;color:#a9abc8;line-height:1.45}.alt b{color:#fff;font-weight:650}
.foot{position:absolute;bottom:${FORMAT === 'square' ? 10 : 28}px;left:0;right:0;font-size:${FORMAT === 'square' ? 10.5 : 12}px;color:#8a8ba3}
#fade{position:absolute;inset:0;background:#000;pointer-events:none}
</style></head><body>
<div id="bg"></div><div id="grain"></div>
<div id="world-wrap"><div id="world"><div class="win">
  <div class="title"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>billing-app — Visual Studio Code</span></div>
  <div class="act"><b class="on"></b><b></b><b></b><b></b></div>
  <div class="chat"><div class="chat-head">CLAUDE CODE</div>
    <div class="chat-body" id="chat-old"><div id="old">${OLD_CHAT}</div></div>
    <div class="chat-body" id="chat-new" style="display:none"><div id="log"></div></div>
    <div class="input"><span id="input-text"></span><span class="send"></span></div>
  </div>
  <div class="right">
    <div class="tabs"><div class="tab active" id="tab-code">lib/stripe.ts</div><div class="tab" id="tab-check" style="display:none"><img src="${tabIcon}">Add Stripe billing</div></div>
    <div id="editor">${CODE.split('\n').map((l, i) => `<span class="ln">${i + 1}</span>${l}`).join('\n')}</div>
    <iframe id="panel" style="opacity:0"></iframe>
  </div>
</div></div><div id="vignette"></div></div>
<div id="chips"></div>
<div id="caps"></div>
<div id="notify" style="display:none"></div>
<div id="ripple" style="display:none"></div>
<svg id="cursor" viewBox="0 0 22 22" style="display:none"><path d="M2 2 L2 18 L6.4 14 L9.3 20.4 L12.2 19.1 L9.4 12.9 L15.4 12.9 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>
<div id="keycap" style="display:none"></div>
<div id="end" style="display:none">
  <img class="icon" src="${icon}" data-in="0.15">
  <h1 data-in="0.35">Checklist Bridge</h1>
  <div class="tag" data-in="0.55">Give every Claude Code chat<br>its own checklist.</div>
  <div class="pills" data-in="0.8"><span>Free</span><span>Open source</span><span>macOS · Windows · Linux</span></div>
  <div class="steps">
    <h2 data-in="1.2">Get it free in VS Code</h2>
    <div class="step" data-step="1" data-in="1.35"><b>1</b><span>Open the Extensions panel: <kbd>Ctrl+Shift+X</kbd> or <kbd>⌘⇧X</kbd></span></div>
    <div class="step" data-step="2" data-in="1.5"><b>2</b><span>Search “Checklist Bridge”</span></div>
    <div class="step" data-step="3" data-in="1.65"><b>3</b><span>Click Install</span></div>
  </div>
  <div class="search" data-in="1.8"><div class="bar"><span class="label">EXTENSIONS</span><div class="q"><span id="search-text"></span><span id="search-caret"></span></div></div>
    <div id="result"><img src="${icon}"><div><div class="n">Checklist Bridge for Claude Code</div><div class="d">A checklist for every Claude Code chat</div><div class="p">Akshat Agrawal</div></div><span class="btn" id="install">Install</span></div></div>
  <div class="alt" data-in="4.9">Also on the <b>VS Code Marketplace</b> and at<br><b>github.com/Akshat270/checklist-bridge</b></div>
  <div class="foot" data-in="1.8">Works with Claude Code in VS Code, Cursor and VSCodium. Not affiliated with Anthropic.</div>
</div>
<div id="fade"></div>
<script>window.LAYOUT=${JSON.stringify(L)};window.CAPTIONS=${JSON.stringify(CAPTIONS)};window.CAMERA=${JSON.stringify(CAMERA)};window.CHAT=${JSON.stringify(CHAT)};window.INPUT=${JSON.stringify(INPUT)};window.SEARCH=${JSON.stringify(SEARCH)};window.END_AT=${END_AT};</script>
<script>${fs.readFileSync(path.join(HERE, 'stage.js'), 'utf8')}</script>
</body></html>`;

/* ------------------------------------------------------------------ store (the real model) ------------------------------------------------------------------ */
const store = new ChecklistStore();
const SESSION = 'promo';
const tool = (name, args) => store.handleTool(SESSION, {}, name, args);
const listId = () => store.all()[0]?.id;

/* ------------------------------------------------------------------ timeline ------------------------------------------------------------------ */
const events = []; // for the audio: { t, type }
const sfx = (t, type, extra = {}) => events.push({ t: +t.toFixed(3), type, ...extra });
const actions = []; // { at, fn }
const at = (t, fn) => actions.push({ at: t, fn });

const view = { panelIn: 10.3, cursor: { x: 880, y: 1000, op: 0, press: false, ripple: null }, keycap: null, notify: null };
const tweens = []; // cursor moves: { a, b, from, to }

const TASKS = [
  { text: 'Create a product called “Pro” with a monthly price', detail: 'Stripe dashboard → Products → Add product. Pick Recurring, monthly.', group: 'Stripe dashboard' },
  { text: 'Copy the price id into .env.local', command: 'STRIPE_PRICE_PRO=price_…', group: 'Stripe dashboard', tags: ['quick'] },
  { text: 'Add the webhook endpoint', detail: 'Send checkout.session.completed to /api/stripe/webhook.', group: 'Stripe dashboard' },
  { text: 'Pay with the 4242 test card and check the plan changes', group: 'Check it works' },
  { text: 'Tell me which currencies you sell in', group: 'Check it works', tags: ['optional'] },
];
[10.45, 10.65, 10.85, 11.05, 11.25].forEach((t, i) => at(t, () => {
  tool('checklist_add_tasks', { title: 'Add Stripe billing', tasks: [TASKS[i]] });
  sfx(t, 'pop', { n: i });
}));
// Scene markers for the audio.
for (const t of [7.75, 9.9, 12.0, 24.55, 27.85, 31.85]) sfx(t, 'whoosh');
sfx(0.0, 'riser');
sfx(5.6, 'lift');
sfx(END_AT, 'end');
for (let i = 0; i < INPUT.text.length; i++) sfx(INPUT.a + (INPUT.b - 0.25 - INPUT.a) * (i / INPUT.text.length), 'key');
sfx(INPUT.b, 'send');

// Scene 4: an urgent task arrives and jumps to the top.
at(14.4, () => {
  tool('checklist_add_tasks', { tasks: [{ text: 'Roll the Stripe key you pasted in Slack', detail: 'Developers → API keys → Roll key. Then paste the new key into .env.local.', command: 'STRIPE_SECRET_KEY=sk_test_…', tags: ['urgent'] }] });
  sfx(14.4, 'alert');
});
const notifyWin = [14.3, 15.9];

// Cursor helpers.
function move(a, b, target) { tweens.push({ a, b, target }); }
function click(t, sel, kind = 'click') {
  at(t, async (fr) => { await fr.evaluate((s) => { const el = window.__find(s); el && el.click(); }, sel); });
  sfx(t, kind);
  clicks.push(t);
}
const clicks = [];
const show = [[15.6, 17.95], [18.67, 23.9], [28.85, 31.6]];

move(15.65, 16.4, '.task.current .cmd button');
click(16.6, '.task.current .cmd button', 'click');
move(17.2, 17.9, '.task.current .tick');
// Scene 5: tick, note, paste, share.
click(18.85, '.task.current .tick', 'tick');
move(19.1, 19.55, '.task.current textarea.note');
at(19.62, async (fr) => { await fr.evaluate(() => document.querySelector('.task.current textarea.note').focus()); });
sfx(19.62, 'click'); clicks.push(19.62);
const NOTE = 'Rolled it. New key is in .env.local';
const typeA = 19.8, typeB = 21.45;
for (let i = 0; i < NOTE.length; i++) {
  const t = typeA + (typeB - typeA) * (i / NOTE.length);
  at(t, async (fr, page) => { await page.keyboard.type(NOTE[i]); });
  sfx(t, 'key');
}
const keycapWin = [21.75, 22.65];
at(22.0, async (fr) => {
  await fr.evaluate((data) => {
    const bin = atob(data), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u], 'shot.png', { type: 'image/png' }));
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64(path.join(HERE, 'shot.png')));
});
sfx(22.0, 'paste');
move(22.55, 23.2, 'text:Share as done');
click(23.4, 'text:Share as done', 'share');
at(24.95, () => { tool('checklist_read', {}); });
// Scene 6: a question to decide later.
at(26.8, () => {
  tool('checklist_ask', { questions: [{
    question: 'Should the free trial ask for a card?', why: 'Changes the sign-up page and when Stripe first charges.', recommended: 'No card for 14 days', reason: 'More people sign up. You can ask for a card on day 14.',
    options: [{ label: 'No card for 14 days', summary: 'Ask for a card when the trial ends' }, { label: 'Card up front', summary: 'Fewer sign-ups, more of them pay' }, { label: 'No trial', summary: 'Free plan only' }],
  }] });
  sfx(26.8, 'pop', { n: 2 });
});
move(28.95, 29.7, '.qcard .opt-main');
click(29.9, '.qcard .opt-main', 'tick');
move(30.3, 30.95, '.qcard .share-q');
click(31.15, '.qcard .share-q', 'share');
at(33.55, () => { tool('checklist_read', {}); });

/* ------------------------------------------------------------------ cursor per frame ------------------------------------------------------------------ */
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
async function targetPoint(fr, sel) {
  const r = await fr.evaluate((s) => { const el = window.__find(s); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
  if (!r) { console.warn('no target', sel); return null; }
  const w = /tick/.test(sel) ? 0.5 : 0.42;
  return { x: PANEL_X + r.x + r.w * w, y: PANEL_Y + r.y + r.h * 0.55 };
}
async function cursorAt(t, fr) {
  const c = view.cursor;
  for (const tw of tweens) {
    if (t >= tw.a && !tw.from) { tw.from = { x: c.x, y: c.y }; tw.to = await targetPoint(fr, tw.target) || tw.from; }
    if (tw.from && t <= tw.b + 1 / FPS) {
      const k = ease(clamp((t - tw.a) / (tw.b - tw.a)));
      // A slight arc, like a hand.
      c.x = tw.from.x + (tw.to.x - tw.from.x) * k;
      c.y = tw.from.y + (tw.to.y - tw.from.y) * k - Math.sin(k * Math.PI) * 18;
    }
  }
  const vis = show.some(([a, b]) => t >= a && t <= b);
  const fade = show.map(([a, b]) => Math.min(clamp((t - a) / 0.25), clamp((b - t) / 0.25))).reduce((m, x) => Math.max(m, x), 0);
  c.op = vis ? fade : 0;
  c.press = clicks.some((k) => t >= k - 0.02 && t < k + 0.12);
  const rip = clicks.find((k) => t >= k && t < k + 0.45);
  c.ripple = rip != null ? (t - rip) / 0.45 : null;
  const kin = Math.min(clamp((t - keycapWin[0]) / 0.15), clamp((keycapWin[1] - t) / 0.2));
  view.keycap = t >= keycapWin[0] && t <= keycapWin[1] ? { x: c.x + 60, y: c.y + 26, text: 'Ctrl + V', op: kin } : null;
  const nin = Math.min(clamp((t - notifyWin[0]) / 0.25), clamp((notifyWin[1] - t) / 0.3));
  view.notify = t >= notifyWin[0] && t <= notifyWin[1] ? { html: '<i></i>Claude added an urgent task', op: nin } : null;
}

/* ------------------------------------------------------------------ run ------------------------------------------------------------------ */
(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: L.W, height: L.H }, deviceScaleFactor: 2 });
  await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-20T10:00:01Z'));
  await page.setContent(stageHtml);
  await page.evaluate((doc) => { document.getElementById('panel').srcdoc = doc; }, panelDoc);
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate(() => document.getElementById('panel').contentWindow?.__out?.length > 0)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const fr = page.frames().find((f) => f !== page.mainFrame());
  await fr.evaluate(() => {
    // Find an element by selector, or by "text:..." for buttons and options.
    window.__find = (s) => {
      if (!s.startsWith('text:')) return document.querySelector(s);
      const want = s.slice(5);
      const all = [...document.querySelectorAll('button, .opt, label, [role=button], span')];
      const hit = all.filter((e) => e.textContent.trim() === want && e.offsetParent);
      return hit[0] ? hit[0].closest('button, .opt, label, [role=button]') || hit[0] : null;
    };
    window.__seen = new Set();
    window.__state = (m) => {
      window.dispatchEvent(new MessageEvent('message', { data: m }));
      // Rows that are new slide in (driven by the frame clock like every other animation).
      document.querySelectorAll('.task[data-id], .qcard').forEach((el) => {
        const id = el.dataset.id || el.id;
        if (!id || window.__seen.has(id)) return;
        window.__seen.add(id);
        el.animate([{ opacity: 0, transform: 'translateY(10px) scale(.98)', background: 'rgba(139,143,249,.25)' }, { opacity: 1, transform: 'none', background: 'rgba(139,143,249,.12)', offset: 0.5 }, { opacity: 1, transform: 'none', background: 'transparent' }], { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
    };
  });
  await fr.evaluate(() => { window.__out.length = 0; });

  // Same mapping as src/panels.ts onMessage, against the real store.
  const state = () => {
    const c = store.get(listId());
    return { type: 'state', list: JSON.parse(JSON.stringify(c)), routes: { waiting: false, channel: true, terminal: false } };
  };
  let lastRev = '';
  async function pump() {
    for (let i = 0; i < 5; i++) {
      const msgs = await fr.evaluate(() => window.__out.splice(0));
      const id = listId();
      for (const m of msgs) {
        if (!id) break;
        switch (m.type) {
          case 'draft': store.setDraft(id, m.taskId, { done: m.done, note: m.note }); break;
          case 'addImages': store.addImages(id, m.taskId, m.images || []); break;
          case 'share': store.setDraft(id, m.taskId, { done: !!m.done, note: m.note }); store.share(id, m.taskId); break;
          case 'answerDraft': store.setAnswerDraft(id, m.qid, { picks: m.picks, other: m.other, note: m.note }); break;
          case 'shareAnswer': store.setAnswerDraft(id, m.qid, { picks: m.picks, other: m.other, note: m.note }); store.shareAnswer(id, m.qid); break;
          case 'copy': await fr.evaluate(() => window.__state({ type: 'toast', text: 'Copied' })); break;
        }
      }
      if (!id) return;
      const s = state();
      const rev = JSON.stringify(s.list);
      if (rev !== lastRev) { lastRev = rev; await fr.evaluate((m) => window.__state(m), s); }
      if (!msgs.length) return;
    }
  }
  // Freeze every CSS animation/transition and drive it from the fake clock.
  const syncAnims = () => {
    const now = performance.now();
    for (const a of document.getAnimations()) {
      if (a.__s == null) { a.__s = now; a.pause(); }
      a.currentTime = now - a.__s;
    }
  };

  const frames = PREVIEW ? null : Math.round(DURATION * FPS);
  const outFile = path.join(OUT, `video-${FORMAT}.mp4`);
  let ff = null;
  if (!PREVIEW) {
    ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile], { stdio: ['pipe', 'inherit', 'inherit'] });
  }
  const want = PREVIEW ? new Set(PREVIEW.map((t) => Math.round(t * FPS))) : null;
  const last = PREVIEW ? Math.max(...want) : frames - 1;
  actions.sort((a, b) => a.at - b.at);
  let ai = 0;
  const t0 = Date.now();
  for (let f = 0; f <= last; f++) {
    const t = f / FPS;
    while (ai < actions.length && actions[ai].at <= t + 1e-6) { await actions[ai].fn(fr, page); ai++; await pump(); }
    await page.clock.runFor(1000 / FPS);
    await pump();
    await cursorAt(t, fr);
    await page.evaluate(([t, v]) => window.renderFrame(t, v), [t, view]);
    await page.evaluate(`(${syncAnims})()`);
    await fr.evaluate(`(${syncAnims})()`);
    if (want && !want.has(f)) continue;
    const buf = await page.screenshot({ type: 'jpeg', quality: 94 });
    if (want) fs.writeFileSync(path.join(OUT, `prev-${FORMAT}-${t.toFixed(2)}.jpg`), buf);
    else if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 150 === 0) console.log(`frame ${f}/${last} t=${t.toFixed(1)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  if (ff) { ff.stdin.end(); await new Promise((r) => ff.on('close', r)); console.log('wrote', outFile); }
  fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify({ duration: DURATION, events: events.sort((a, b) => a.t - b.t) }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
