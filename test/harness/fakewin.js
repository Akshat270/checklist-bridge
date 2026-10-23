// Runs the real extension in a fake VS Code window. argv: name folder extDir storageDir focused(0/1)
const Module = require('module');
const path = require('path');
const [name, folder, extDir, storage, focused] = process.argv.slice(2);
const noop = { dispose() {} };
let tree;
const commands = {};
const terminals = []; const termOpen = [];
const panels = [];
let focusListener; let serializer;
const ev = () => () => noop;
class EventEmitter { constructor() { this.l = []; this.event = (f) => (this.l.push(f), noop); } fire(x) { this.l.forEach((f) => f(x)); } }
const Uri = { parse: (v) => ({ fsPath: v, toString() { return v; } }), joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p), toString() { return this.fsPath; } }), file: (p) => ({ fsPath: p, toString() { return 'vscode-resource:' + p; } }) };
const say = (m) => process.send(m);
// Settings like VS Code's: user settings (CB_SETTINGS) and project settings (CB_WS_SETTINGS, i.e. a repo's
// .vscode/settings.json). Like VS Code, project values are ignored for settings declared
// "application" or "machine" scope in package.json.
const declared = require(path.join(extDir, 'package.json')).contributes.configuration.properties;
const userSettings = JSON.parse(process.env.CB_SETTINGS || '{}');
userSettings.autoConnect ??= process.env.CB_AUTOCONNECT === '1';
const wsSettings = JSON.parse(process.env.CB_WS_SETTINGS || '{}');
const config = (section) => ({
  get: (k, d) => {
    const scope = declared[`${section}.${k}`]?.scope;
    if (k in wsSettings && (process.env.CB_IGNORE_SCOPES || !['application', 'machine'].includes(scope))) return wsSettings[k];
    return k in userSettings ? userSettings[k] : d;
  },
  inspect: (k) => ({ key: `${section}.${k}`, defaultValue: declared[`${section}.${k}`]?.default, globalValue: userSettings[k], workspaceValue: wsSettings[k] }),
});
const vscode = {
  EventEmitter, Uri, ThemeColor: class {}, ThemeIcon: class {}, MarkdownString: class {},
  TreeItem: class { constructor(l) { this.label = l; } },
  ViewColumn: { Beside: -2 }, ProgressLocation: { Window: 10, Notification: 15 }, StatusBarAlignment: { Right: 2 },
  window: {
    state: { focused: focused === '1' },
    terminals,
    // Tabs VS Code is still holding from before the restart, not yet handed back (env TABS='["title"]').
    tabGroups: { get all() { const tab = (label) => ({ label, input: { viewType: 'mainThreadWebview-checklistBridge.checklist' } }); return [{ tabs: [...JSON.parse(process.env.TABS || '[]'), ...panels.filter((p) => !p.gone).map((p) => p.title)].map(tab) }]; } },
    onDidOpenTerminal: (fn) => (termOpen.push(fn), noop),
    onDidCloseTerminal: () => noop,
    setStatusBarMessage: (m) => (say({ log: `[${name}] STATUS ${m}` }), noop),
    showErrorMessage: async (m) => (say({ log: `[${name}] ERROR ${m}` }), undefined),
    onDidChangeWindowState: (f) => ((focusListener = f), noop),
    createOutputChannel: () => ({ appendLine: (s) => say({ log: `[${name}] ${s}` }), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTreeView: (_id, o) => ((tree = o.treeDataProvider), { dispose() {}, onDidChangeVisibility: ev() }),
    showInformationMessage: async (m) => (say({ log: `[${name}] NOTIFY ${m}` }), undefined),
    showWarningMessage: async (m, o) => (say({ log: `[${name}] WARN ${m}`, warn: m, detail: o?.detail }), /^Close /.test(m) ? 'Close checklist' : undefined),
    showQuickPick: async () => undefined,
    withProgress: async (o, task) => { say({ log: `[${name}] PROGRESS ${o.title}` }); return task(); },
    createTerminal: () => ({ show() {}, sendText: (t) => say({ log: `[${name}] TERMINAL ${t}` }) }),
    registerWebviewPanelSerializer: (t, ser) => ((serializer = ser), noop),
    createWebviewPanel: (type, title) => {
      const msg = new EventEmitter(), disp = new EventEmitter();
      const p = {
        title, webview: { options: {}, cspSource: 'x', asWebviewUri: (u) => u, onDidReceiveMessage: msg.event, postMessage: async (m) => { if (m.type === 'state') { p.state = m.list; p.routes = m.routes; say({ state: m, title: p.title }); } else say({ webMsg: m, title: p.title }); if (m.type === 'flush') setTimeout(() => { for (const x of p.unsaved || []) msg.fire(x); p.unsaved = []; msg.fire({ type: 'flushed' }); }, 20); return true; }, set html(v) { setTimeout(() => msg.fire({ type: 'ready' })); } },
        onDidDispose: disp.event, reveal() {}, dispose() { if (p.gone) return; p.gone = true; disp.fire(); say({ panelClosed: p.title }); },
        user: (m) => msg.fire(m),
      };
      panels.push(p);
      say({ panelOpened: title, window: name });
      return p;
    },
  },
  commands: { registerCommand: (n, f) => ((commands[n] = f), noop), executeCommand: (n, ...a) => { if (n === 'setContext') { say({ context: { [a[0]]: a[1] } }); return Promise.resolve(); } if (n.startsWith('workbench.')) { say({ log: `[${name}] VSCODE ${n} ${a.map(String).join(' ')}` }); return Promise.resolve(); } return commands[n](...a); } },
  workspace: { name, workspaceFolders: process.env.CB_FOLDERLESS ? undefined : [{ uri: { fsPath: folder }, name }], workspaceFile: undefined, onDidChangeWorkspaceFolders: ev(), getConfiguration: (section) => config(section) },
  env: { clipboard: { writeText: async (t) => say({ clipboard: t }) }, openExternal: async (u) => (say({ opened: String(u) }), true) },
  extensions: { getExtension: (id) => (process.env.HAS_OLD === '1' && id === 'akshat.checklist-bridge' ? { id } : undefined) },
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
const ext = require(extDir + '/dist/extension.js');
const ctx = {
  subscriptions: [], extensionUri: { fsPath: extDir }, storageUri: { fsPath: storage }, globalStorageUri: { fsPath: storage },
  // Like VS Code's: remembered across restarts of the same window (kept in the storage folder).
  globalState: (() => {
    const f = path.join(storage, 'globalState.json');
    const read = () => { try { return JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch { return { connectedPrompted: true, claudeSetupAsked: true }; } };
    return { get: (k, d) => (k in read() ? read()[k] : d), update: async (k, v) => { require('fs').mkdirSync(storage, { recursive: true }); require('fs').writeFileSync(f, JSON.stringify({ ...read(), [k]: v })); } };
  })(),
  environmentVariableCollection: { replace: (k, v) => say({ windowId: v }) },
};
ext.activate(ctx).then(() => say({ ready: name }));

process.on('message', (m) => {
  if (m.cmd === 'focus') { vscode.window.state.focused = true; focusListener({ focused: true }); }
  if (m.cmd === 'panels') say({ panels: panels.filter((p) => !p.gone).map((p) => ({ title: p.title, away: !!p.state?.away, awayLeft: p.state?.awayLeft, awayLabel: p.state?.awayLabel, awayMs: p.state?.awayMs, id: p.state?.id, routes: p.routes, questions: (p.state?.questions || []).map((q) => ({ id: q.id, answered: !!q.answer, seen: !!q.seenAt, pushed: !!q.pushedAt, retired: !!q.retired })), tasks: (p.state?.tasks || []).map((t) => t.id + (t.shared ? '*' : '')) })) });
  if (m.cmd === 'addTerminal') { const t = { name: 'claude', processId: Promise.resolve(m.pid), show() {}, sendText: (x) => say({ termText: x }) }; terminals.push(t); termOpen.forEach((fn) => fn(t)); setTimeout(() => say({ done: 1 }), 300); }
  // What the panel holds back and sends only when asked to flush (typing not saved yet), like the real panel.
  if (m.cmd === 'unsaved') { panels.find((x) => !x.gone && x.title === m.title).unsaved = m.msgs; say({ done: 1 }); }
  if (m.cmd === 'user') { const p = panels.find((x) => !x.gone && x.title === m.title); p.user({ ...m.msg }); setTimeout(() => say({ done: 1 }), 50); }
  if (m.cmd === 'closeTab') { panels.find((x) => !x.gone && x.title === m.title).dispose(); setTimeout(() => say({ done: 1 }), 50); }
  if (m.cmd === 'clickItem') { const c = tree.getChildren().find((x) => x.title === m.title); const k = tree.getTreeItem(c).command; Promise.resolve(commands[k.command](...k.arguments)).then(() => setTimeout(() => say({ done: 1 }), 50)); }
  if (m.cmd === 'command') { Promise.resolve(commands[m.name](...(m.args || []))).then(() => setTimeout(() => say({ done: 1 }), 50)); }
  if (m.cmd === 'restoreTab') { const p = vscode.window.createWebviewPanel('checklistBridge.checklist', 'restored'); Promise.resolve(serializer ? serializer.deserializeWebviewPanel(p, { listId: m.listId }) : p.dispose()).then(() => setTimeout(() => say({ done: 1 }), 100)); }
  if (m.cmd === 'shutdown') { panels.filter((p) => !p.gone).forEach((p) => p.dispose()); ext.deactivate(); setTimeout(() => process.exit(0), 300); }
  if (m.cmd === 'quit') { ext.deactivate(); setTimeout(() => process.exit(0), 600); }
});
