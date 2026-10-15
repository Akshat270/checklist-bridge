const __ROOT = require('path').resolve(__dirname, '..');
// Fake "GitHub" (local http) serving the repo; extension pretends to be 0.2.2 and must install 0.2.3.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), Module = require('module');
const REPO = __ROOT;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbu-'));
process.env.CHECKLIST_BRIDGE_HOME = HOME;
let failed = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

const srv = http.createServer((req, res) => {
  const f = path.join(REPO, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(REPO) || !fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200); fs.createReadStream(f).pipe(res);
});
srv.listen(0, '127.0.0.1', async () => {
  process.env.CHECKLIST_BRIDGE_UPDATE_BASE = `http://127.0.0.1:${srv.address().port}/`;
  const installed = [], shown = [], cmds = {};
  const noop = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }), file: (p) => ({ fsPath: p }) },
    window: {
      showInformationMessage: async (m, ...items) => (shown.push(m), undefined),
      showWarningMessage: async (m) => (shown.push('WARN ' + m), undefined),
      onDidChangeWindowState: () => noop,
    },
    workspace: { getConfiguration: () => ({ get: (k, d) => d, inspect: () => undefined }) },
    commands: {
      registerCommand: (n, f) => ((cmds[n] = f), noop),
      executeCommand: async (n, uri) => { if (n === 'workbench.extensions.installExtension') installed.push(uri.fsPath); },
    },
  };
  const orig = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
  const { startUpdater } = require(REPO + '/dist/updater.js');
  const ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') } };
  const logs = [];
  startUpdater(ctx, '0.2.2', (s) => logs.push(s));

  await cmds['checklistBridge.checkForUpdates']();
  const latest = JSON.parse(fs.readFileSync(REPO + '/latest.json'));
  check(installed.length === 1, 'older install downloads and installs the new .vsix');
  check(installed[0] && crypto.createHash('sha256').update(fs.readFileSync(installed[0])).digest('hex') === latest.sha256, 'installed file matches the published checksum');
  check(shown.some((m) => m.includes('updated to ' + latest.version)), 'user is offered a reload: ' + shown.find((m) => /updated/.test(m)));

  // Same version installed -> nothing happens, says up to date.
  installed.length = 0; shown.length = 0;
  const ctx2 = { subscriptions: [], globalStorageUri: ctx.globalStorageUri };
  const c2 = {}; vscode.commands.registerCommand = (n, f) => ((c2[n] = f), noop);
  startUpdater(ctx2, latest.version, () => {});
  await c2['checklistBridge.checkForUpdates']();
  check(!installed.length && shown.some((m) => /up to date/.test(m)), 'current version: nothing installed');

  // Tampered download -> refused.
  const bad = { ...latest, sha256: '0'.repeat(64), version: '9.9.9' };
  fs.writeFileSync(REPO + '/latest.json.bak', fs.readFileSync(REPO + '/latest.json'));
  fs.writeFileSync(REPO + '/latest.json', JSON.stringify(bad));
  installed.length = 0; shown.length = 0;
  const c3 = {}; vscode.commands.registerCommand = (n, f) => ((c3[n] = f), noop);
  startUpdater({ subscriptions: [], globalStorageUri: ctx.globalStorageUri }, latest.version, () => {});
  await c3['checklistBridge.checkForUpdates']();
  fs.renameSync(REPO + '/latest.json.bak', REPO + '/latest.json');
  check(!installed.length && shown.some((m) => /checksum/.test(m)), 'corrupted download is refused');

  for (const d of ctx.subscriptions.concat(ctx2.subscriptions)) d.dispose?.();
  srv.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
});
