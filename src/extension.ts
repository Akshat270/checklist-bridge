import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Checklist, ChecklistStore } from './model';
import { createWindowServer } from './windowServer';
import { ENV_WINDOW, ROOT, removeWindow, writeWindow } from './registry';
import { Panels } from './panels';
import { ChecklistTree } from './sidebar';
import { startUpdater } from './updater';
import { applySetup, claudeDir, isSetUp, removeSetup } from './claudeSetup';

let server: http.Server | undefined;
let windowId = '';
let regTimer: NodeJS.Timeout | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Checklist Bridge');
  const log = (s: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);

  /* ---------- identity of this window ---------- */
  // Stable per workspace so chats started before a reload still find the window afterwards.
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const wsKey = vscode.workspace.workspaceFile?.toString() ?? folders.join('|');
  windowId = wsKey ? 'ws-' + createHash('sha1').update(wsKey).digest('hex').slice(0, 16) : 'empty-' + randomUUID().slice(0, 8);
  // Chats started from this window (its terminals, or Claude Code's own panel in this extension host)
  // inherit this, so their checklist always opens here.
  process.env[ENV_WINDOW] = windowId;
  ctx.environmentVariableCollection.replace(ENV_WINDOW, windowId);

  /* ---------- storage ---------- */
  const dir = vscode.Uri.joinPath(ctx.storageUri ?? ctx.globalStorageUri, 'checklists').fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (id: string) => path.join(dir, `${id}.json`);
  const initial: Checklist[] = [];
  for (const n of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      initial.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    } catch {
      /* ignore broken file */
    }
  }
  const store = new ChecklistStore(initial);
  const saveTimers = new Map<string, NodeJS.Timeout>();
  const save = (c: Checklist) => {
    clearTimeout(saveTimers.get(c.id));
    saveTimers.set(
      c.id,
      setTimeout(() => fs.promises.writeFile(fileOf(c.id), JSON.stringify(c)).catch((e) => log(`Save failed: ${e}`)), 400)
    );
  };

  /* ---------- UI ---------- */
  const panels = new Panels(store, ctx.extensionUri);
  const tree = new ChecklistTree(store, panels);
  const view = vscode.window.createTreeView('checklistBridge.list', { treeDataProvider: tree });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'checklistBridge.pick';

  const refreshChrome = () => {
    const lists = store.all();
    const todo = lists.reduce((n, c) => n + c.tasks.filter((t) => !t.shared).length, 0);
    view.badge = todo ? { value: todo, tooltip: `${todo} task${todo === 1 ? '' : 's'} waiting for you` } : undefined;
    if (lists.length) {
      status.text = todo ? `$(checklist) ${todo} to do` : '$(checklist) All shared';
      status.tooltip = `${lists.length} checklist${lists.length === 1 ? '' : 's'} in this window. Click to show one.`;
      status.show();
    } else status.hide();
    tree.refresh();
  };

  store.onChange((e) => {
    const c = e.checklist;
    if (e.kind === 'removed') {
      fs.promises.unlink(fileOf(c.id)).catch(() => {});
      return refreshChrome();
    }
    save(c);
    if (e.kind === 'created') panels.show(c);
    else if (e.kind === 'tasks-added' && !panels.isOpen(c.id)) {
      vscode.window
        .showInformationMessage(`Claude added ${e.added} task${e.added === 1 ? '' : 's'} to "${c.title}".`, 'Show')
        .then((pick) => pick && panels.show(c, { focus: true }));
    }
    panels.update(c);
    refreshChrome();
  });
  store.prune(3 * 24 * 3600_000);

  /* ---------- server + registration ---------- */
  const token = randomBytes(24).toString('hex');
  server = createWindowServer(store, token, log);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let focusedAt = vscode.window.state.focused ? Date.now() : 0;
  const register = () => {
    try {
      writeWindow({
        windowId,
        port,
        token,
        pid: process.pid,
        folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        focusedAt,
        name: vscode.workspace.name ?? 'Untitled window',
      });
    } catch (e) {
      log(`Could not register window: ${e}`);
    }
  };
  register();
  regTimer = setInterval(register, 60_000); // heals the file if something deleted it
  log(`Window "${vscode.workspace.name ?? 'Untitled'}" ready (id ${windowId}, port ${port}).`);

  /* ---------- connector install ---------- */
  const connectorSrc = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'connector.js').fsPath;
  const connectorDir = path.join(ROOT, 'connector');
  const connectorPath = path.join(connectorDir, 'connector.js');
  try {
    // A stable copy outside the extension folder, so the Claude Code setup survives extension updates.
    fs.mkdirSync(connectorDir, { recursive: true });
    for (const f of ['connector.js', 'model.js', 'registry.js'])
      fs.copyFileSync(path.join(path.dirname(connectorSrc), f), path.join(connectorDir, f));
  } catch (e) {
    log(`Could not copy the connector: ${e}`);
  }

  const hasNode = () => new Promise<boolean>((r) => execFile('node', ['--version'], { timeout: 4000 }, (e) => r(!e)));
  const q = (s: string) => (/[\s"'()&]/.test(s) ? `"${s}"` : s);
  const setupCommand = async () =>
    (await hasNode())
      ? `claude mcp add --transport stdio --scope user checklist -- node ${q(connectorPath)}`
      : `claude mcp add --env ELECTRON_RUN_AS_NODE=1 --transport stdio --scope user checklist -- ${q(process.execPath)} ${q(connectorPath)}`;

  /* ---------- commands ---------- */
  const resolve = (arg: unknown): Checklist | undefined =>
    typeof arg === 'string' ? store.get(arg) : (arg as Checklist)?.id ? store.get((arg as Checklist).id) : undefined;

  ctx.subscriptions.push(
    output,
    view,
    status,
    view.onDidChangeVisibility(() => tree.refresh()),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        focusedAt = Date.now();
        register();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(register),

    vscode.commands.registerCommand('checklistBridge.toggle', (arg) => {
      const c = resolve(arg);
      if (!c) return;
      panels.isOpen(c.id) ? panels.hide(c.id) : panels.show(c, { focus: true });
      tree.refresh();
    }),
    vscode.commands.registerCommand('checklistBridge.show', (arg) => {
      const c = resolve(arg);
      if (c) panels.show(c, { focus: true });
      tree.refresh();
    }),
    vscode.commands.registerCommand('checklistBridge.hide', (arg) => {
      const c = resolve(arg);
      if (c) panels.hide(c.id);
      tree.refresh();
    }),
    vscode.commands.registerCommand('checklistBridge.showAll', () => store.all().forEach((c) => panels.show(c))),
    vscode.commands.registerCommand('checklistBridge.hideAll', () => store.all().forEach((c) => panels.hide(c.id))),
    vscode.commands.registerCommand('checklistBridge.close', async (arg) => {
      const c = resolve(arg);
      if (!c) return;
      const waiting = c.tasks.filter((t) => !t.shared).length;
      const pick = await vscode.window.showWarningMessage(
        `Close "${c.title}"?`,
        {
          modal: true,
          detail:
            (waiting ? `${waiting} task${waiting === 1 ? ' is' : 's are'} still not shared. ` : '') +
            'Claude will be told the checklist was closed. If it adds tasks later, a new checklist opens.',
        },
        'Close checklist'
      );
      if (pick === 'Close checklist') store.close(c.id);
    }),
    vscode.commands.registerCommand('checklistBridge.pick', async () => {
      const lists = store.all();
      if (!lists.length) return vscode.window.showInformationMessage('No checklists in this window yet.');
      const pick = await vscode.window.showQuickPick(
        lists.map((c) => ({
          label: c.title,
          description: `${c.tasks.filter((t) => !t.shared).length} to do`,
          detail: c.folder || undefined,
          id: c.id,
        })),
        { placeHolder: 'Show a checklist' }
      );
      const c = pick && store.get(pick.id);
      if (c) panels.show(c, { focus: true });
    }),
    vscode.commands.registerCommand('checklistBridge.connect', async () => {
      const cmd = await setupCommand();
      const remove = 'claude mcp remove checklist --scope user';
      const term = vscode.window.createTerminal({ name: 'Connect Claude checklists' });
      term.show();
      term.sendText(remove);
      term.sendText(cmd, false);
      vscode.window.showInformationMessage(
        'Press Enter in the terminal to finish. The first line removes an older Checklist Bridge setup if you had one; an error there is fine. Then start a new Claude chat.'
      );
      if (!isSetUp()) vscode.commands.executeCommand('checklistBridge.setupClaude');
    }),
    vscode.commands.registerCommand('checklistBridge.setupClaude', async () => {
      ctx.globalState.update('claudeSetupAsked', true);
      const dir = claudeDir();
      const pick = await vscode.window.showInformationMessage(
        'Make every Claude Code chat on this computer use checklists automatically?',
        {
          modal: true,
          detail:
            `This adds a short instruction to ${path.join(dir, 'CLAUDE.md')}, which every Claude Code chat reads, ` +
            `and allows the checklist tools in ${path.join(dir, 'settings.json')} so Claude doesn't ask before each use. ` +
            'You can undo it any time with "Checklist Bridge: Undo Claude Code setup".',
        },
        'Set up'
      );
      if (pick !== 'Set up') return;
      try {
        const r = applySetup(dir);
        log(`Claude setup: instructions ${r.instructions}, permission ${r.permission}`);
        if (r.note) vscode.window.showWarningMessage(r.note, {});
        vscode.window.showInformationMessage('Done. New Claude Code chats will use your checklist automatically.');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Couldn't update Claude Code's settings: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('checklistBridge.removeClaudeSetup', () => {
      try {
        const r = removeSetup(claudeDir());
        log(`Claude setup removed: instructions ${r.instructions}, permission ${r.permission}`);
        vscode.window.showInformationMessage(
          r.instructions === 'absent' && r.permission !== 'removed'
            ? 'There was nothing to undo.'
            : 'Removed. Claude Code chats will no longer be told to use the checklist (the tools stay available).'
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Couldn't update Claude Code's settings: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('checklistBridge.copySetup', async () => {
      await vscode.env.clipboard.writeText(await setupCommand());
      vscode.window.showInformationMessage('Setup command copied.');
    }),
    vscode.commands.registerCommand('checklistBridge.demo', () => {
      const r = store.handleTool(`demo-${randomUUID()}`, { cwd: folders[0] }, 'checklist_add_tasks', {
        title: 'Example checklist',
        tasks: [
          { text: 'Tick this box, then press Share as done', tags: ['quick'] },
          { text: 'Add a note and paste a screenshot here', detail: 'Click into the note box and paste with Ctrl/Cmd+V.' },
          { text: 'Copy this command', command: 'echo "hello from your checklist"', group: 'Grouped tasks' },
          { text: 'This one is urgent', tags: ['urgent'], group: 'Grouped tasks' },
        ],
      });
      log('Demo created: ' + (r.content[0] as any).text.split('\n')[0]);
    }),
    { dispose: () => panels.disposeAll() }
  );

  // Keep the extension (and with it the Claude Code connector) up to date from GitHub.
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(ctx.extensionUri.fsPath, 'package.json'), 'utf8')).version;
  } catch {
    /* keep 0.0.0 */
  }
  startUpdater(ctx, version, log);

  // Versions before 0.3.1 were published as "akshat.checklist-bridge". Remove that copy so the two don't both run.
  const OLD_ID = 'akshat.checklist-bridge';
  if (vscode.extensions.getExtension(OLD_ID)) {
    vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_ID).then(
      () => {
        log('Removed the old copy of Checklist Bridge (akshat.checklist-bridge).');
        vscode.window
          .showInformationMessage('Checklist Bridge moved to its new home on the Marketplace. Reload to finish.', 'Reload window')
          .then((p) => p && vscode.commands.executeCommand('workbench.action.reloadWindow'));
      },
      (err: unknown) => log(`Could not remove the old copy: ${err}`)
    );
  }

  // Bring back checklists that were showing before the reload.
  for (const c of store.all()) if (!c.hidden) panels.show(c);
  refreshChrome();

  // First run: offer to connect Claude Code.
  if (!ctx.globalState.get('connectedPrompted')) {
    ctx.globalState.update('connectedPrompted', true);
    vscode.window
      .showInformationMessage('Checklist Bridge is installed. Connect it to Claude Code?', 'Connect')
      .then((p) => p && vscode.commands.executeCommand('checklistBridge.connect'));
  } else if (!isSetUp() && !ctx.globalState.get('claudeSetupAsked')) {
    // Existing users: offer the new one-click setup once.
    ctx.globalState.update('claudeSetupAsked', true);
    vscode.window
      .showInformationMessage('Want every Claude Code chat to use your checklist without being told?', 'Set up', 'Not now')
      .then((p) => p === 'Set up' && vscode.commands.executeCommand('checklistBridge.setupClaude'));
  }
}

export function deactivate() {
  if (regTimer) clearInterval(regTimer);
  removeWindow(windowId, process.pid);
  server?.close();
}
