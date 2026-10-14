// Runs the real extension in a fake VS Code window. argv: name folder extDir storageDir focused(0/1)
const Module = require('module');
const path = require('path');
const [name, folder, extDir, storage, focused] = process.argv.slice(2);
const noop = { dispose() {} };
const commands = {};
const terminals = []; const termOpen = [];
const panels = [];
let focusListener; let serializer;
const ev = () => () => noop;
class EventEmitter { constructor() { this.l = []; this.event = (f) => (this.l.push(f), noop); } fire(x) { this.l.forEach((f) => f(x)); } }
const Uri = { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p), toString() { return this.fsPath; } }), file: (p) => ({ fsPath: p }) };
const say = (m) => process.send(m);
const vscode = {
  EventEmitter, Uri, ThemeColor: class {}, ThemeIcon: class {}, MarkdownString: class {},
  TreeItem: class { constructor(l) { this.label = l; } },
  ViewColumn: { Beside: -2 }, StatusBarAlignment: { Right: 2 },
  window: {
    state: { focused: focused === '1' },
    terminals,
    // Tabs VS Code is still holding from before the restart, not yet handed back (env TABS='["title"]').
    tabGroups: { all: [{ tabs: JSON.parse(process.env.TABS || '[]').map((label) => ({ label, input: { viewType: 'mainThreadWebview-checklistBridge.checklist' } })) }] },
    onDidOpenTerminal: (fn) => (termOpen.push(fn), noop),
    onDidCloseTerminal: () => noop,
    setStatusBarMessage: (m) => (say({ log: `[${name}] STATUS ${m}` }), noop),
    showErrorMessage: async (m) => (say({ log: `[${name}] ERROR ${m}` }), undefined),
    onDidChangeWindowState: (f) => ((focusListener = f), noop),
    createOutputChannel: () => ({ appendLine: (s) => say({ log: `[${name}] ${s}` }), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTreeView: () => ({ dispose() {}, onDidChangeVisibility: ev() }),
    showInformationMessage: async (m) => (say({ log: `[${name}] NOTIFY ${m}` }), undefined),
    showWarningMessage: async () => 'Close checklist',
    showQuickPick: async () => undefined,
    createTerminal: () => ({ show() {}, sendText: (t) => say({ log: `[${name}] TERMINAL ${t}` }) }),
    registerWebviewPanelSerializer: (t, ser) => ((serializer = ser), noop),
    createWebviewPanel: (type, title) => {
      const msg = new EventEmitter(), disp = new EventEmitter();
      const p = {
        title, webview: { options: {}, cspSource: 'x', asWebviewUri: (u) => u, onDidReceiveMessage: msg.event, postMessage: async (m) => { if (m.type === 'state') { p.state = m.list; p.routes = m.routes; say({ state: m, title: p.title }); } return true; }, set html(v) { setTimeout(() => msg.fire({ type: 'ready' })); } },
        onDidDispose: disp.event, reveal() {}, dispose() { if (p.gone) return; p.gone = true; disp.fire(); say({ panelClosed: p.title }); },
        user: (m) => msg.fire(m),
      };
      panels.push(p);
      say({ panelOpened: title, window: name });
      return p;
    },
  },
  commands: { registerCommand: (n, f) => ((commands[n] = f), noop), executeCommand: (n, ...a) => { if (n.startsWith('workbench.')) { say({ log: `[${name}] VSCODE ${n} ${a.map(String).join(' ')}` }); return Promise.resolve(); } return commands[n](...a); } },
  workspace: { name, workspaceFolders: [{ uri: { fsPath: folder }, name }], workspaceFile: undefined, onDidChangeWorkspaceFolders: ev(), getConfiguration: () => ({ get: (k, d) => d }) },
  env: { clipboard: { writeText: async (t) => say({ clipboard: t }) } },
  extensions: { getExtension: (id) => (process.env.HAS_OLD === '1' && id === 'akshat.checklist-bridge' ? { id } : undefined) },
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
const ext = require(extDir + '/dist/extension.js');
const ctx = {
  subscriptions: [], extensionUri: { fsPath: extDir }, storageUri: { fsPath: storage }, globalStorageUri: { fsPath: storage },
  globalState: { get: () => true, update: async () => {} },
  environmentVariableCollection: { replace: (k, v) => say({ windowId: v }) },
};
ext.activate(ctx).then(() => say({ ready: name }));

process.on('message', (m) => {
  if (m.cmd === 'focus') { vscode.window.state.focused = true; focusListener({ focused: true }); }
  if (m.cmd === 'panels') say({ panels: panels.filter((p) => !p.gone).map((p) => ({ title: p.title, id: p.state?.id, routes: p.routes, questions: (p.state?.questions || []).map((q) => ({ id: q.id, answered: !!q.answer, seen: !!q.seenAt, pushed: !!q.pushedAt, retired: !!q.retired })), tasks: (p.state?.tasks || []).map((t) => t.id + (t.shared ? '*' : '')) })) });
  if (m.cmd === 'addTerminal') { const t = { name: 'claude', processId: Promise.resolve(m.pid), show() {}, sendText: (x) => say({ termText: x }) }; terminals.push(t); termOpen.forEach((fn) => fn(t)); setTimeout(() => say({ done: 1 }), 300); }
  if (m.cmd === 'user') { const p = panels.find((x) => !x.gone && x.title === m.title); p.user({ ...m.msg }); setTimeout(() => say({ done: 1 }), 50); }
  if (m.cmd === 'closeTab') { panels.find((x) => !x.gone && x.title === m.title).dispose(); setTimeout(() => say({ done: 1 }), 50); }
  if (m.cmd === 'command') { Promise.resolve(commands[m.name](...(m.args || []))).then(() => setTimeout(() => say({ done: 1 }), 50)); }
  if (m.cmd === 'restoreTab') { const p = vscode.window.createWebviewPanel('checklistBridge.checklist', 'restored'); Promise.resolve(serializer ? serializer.deserializeWebviewPanel(p, { listId: m.listId }) : p.dispose()).then(() => setTimeout(() => say({ done: 1 }), 100)); }
  if (m.cmd === 'shutdown') { panels.filter((p) => !p.gone).forEach((p) => p.dispose()); ext.deactivate(); setTimeout(() => process.exit(0), 300); }
  if (m.cmd === 'quit') { ext.deactivate(); setTimeout(() => process.exit(0), 600); }
});
