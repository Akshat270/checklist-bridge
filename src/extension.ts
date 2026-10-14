import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Checklist, ChecklistStore } from './model';
import { createWindowServer, WindowServer } from './windowServer';
import { ENV_WINDOW, ROOT, removeWindow, writeWindow } from './registry';
import { Panels, Routes, VIEW_TYPE } from './panels';
import { ChecklistTree } from './sidebar';
import { startUpdater } from './updater';
import { Saver } from './saver';
import { applySetup, claudeDir, isSetUp, refreshInstructions, removeSetup } from './claudeSetup';

let ws: WindowServer | undefined;
let windowId = '';
let regTimer: NodeJS.Timeout | undefined;
let flushSaves: (() => void) | undefined;
let saveOne: ((c: Checklist) => void) | undefined;
let panelsRef: Panels | undefined;

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
  const initial: Checklist[] = [];
  for (const n of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      initial.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    } catch (e) {
      log(`Skipped an unreadable checklist file ${n}: ${e}`);
    }
  }
  const store = new ChecklistStore(initial);
  const saver = new Saver(dir, (id) => {
    const c = store.get(id);
    return c && JSON.stringify(c);
  }, log);
  const save = (c: Checklist) => saver.mark(c.id);
  flushSaves = () => saver.flushSync();
  saveOne = save;

  /* ---------- how "Send now" reaches each chat ---------- */
  // A chat running in a VS Code terminal: we can type into it. Found by matching the terminal's
  // shell process against the chat's process chain (sent by its connector).
  const termFor = new Map<string, vscode.Terminal>();
  const routes = (c: Checklist): Routes => {
    const info = ws?.sessions.get(c.sessionId);
    const alive = !!ws?.isAlive(c.sessionId);
    return {
      waiting: !!ws?.isWaiting(c.sessionId),
      channel: !!(alive && info?.channel && info.polling),
      // Only while Claude is still running there; otherwise the terminal is back at a shell prompt.
      terminal: alive && !!info?.ancestors.length && termFor.has(c.sessionId),
    };
  };
  const sendNow = async (c: Checklist) => {
    ws?.prune();
    const r = routes(c);
    const line = store.updateSummary(c, 'line');
    if (!line.ids.length) return void vscode.window.setStatusBarMessage('$(check) Nothing new to send', 2500);
    if (r.waiting) return void vscode.window.setStatusBarMessage('$(check) Claude already has it', 2500);
    if (r.channel && ws!.push(c.sessionId, store.updateSummary(c, 'full').text)) {
      store.markPushed(c.id, line.ids);
      log(`Sent ${line.ids.join(', ')} to chat via channel`);
      return void vscode.window.setStatusBarMessage('$(check) Sent to Claude', 3000);
    }
    const term = termFor.get(c.sessionId);
    // Check again right before typing: never type into a shell whose Claude has exited.
    if (r.terminal && term && ws!.isAlive(c.sessionId)) {
      // Type the update into Claude's terminal and press Enter separately, so it isn't taken as a paste.
      term.sendText(line.text, false);
      setTimeout(() => term.sendText('\r', false), 250);
      store.markPushed(c.id, line.ids);
      log(`Sent ${line.ids.join(', ')} to chat via its terminal`);
      return void vscode.window.setStatusBarMessage('$(check) Sent to Claude', 3000);
    }
    await vscode.env.clipboard.writeText(line.text);
    vscode.window.showInformationMessage('Copied. Paste it into the Claude chat and press Enter (Claude also sees it the next time it reads the checklist).');
  };

  /* ---------- UI ---------- */
  const panels = new Panels(store, ctx.extensionUri, { routes, sendNow });
  panelsRef = panels;
  // VS Code reopens checklist tabs that were open when the window closed or reloaded.
  ctx.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (p, state) => panels.restore(p, state),
    })
  );
  const tree = new ChecklistTree(store, panels);
  const view = vscode.window.createTreeView('checklistBridge.list', { treeDataProvider: tree });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'checklistBridge.pick';

  const refreshChrome = () => {
    const lists = store.all();
    const todo = lists.reduce((n, c) => n + c.tasks.filter((t) => !t.shared).length, 0);
    const decide = lists.reduce((n, c) => n + c.questions.filter((q) => !q.answer && !q.retired).length, 0);
    const parts = [todo && `${todo} to do`, decide && `${decide} to decide`].filter(Boolean);
    view.badge = todo + decide ? { value: todo + decide, tooltip: `${parts.join(', ')}` } : undefined;
    if (lists.length) {
      status.text = parts.length ? `$(checklist) ${parts.join(', ')}` : '$(checklist) All shared';
      status.tooltip = `${lists.length} checklist${lists.length === 1 ? '' : 's'} in this window. Click to show one.`;
      status.show();
    } else status.hide();
    tree.refresh();
  };

  store.onChange((e) => {
    const c = e.checklist;
    if (e.kind === 'removed') {
      saver.remove(c.id);
      return refreshChrome();
    }
    save(c);
    if (e.kind === 'created') panels.show(c);
    else if (e.kind === 'tasks-added' && !panels.isOpen(c.id)) {
      vscode.window
        .showInformationMessage(`Claude added ${e.added} task${e.added === 1 ? '' : 's'} to "${c.title}".`, 'Show')
        .then((pick) => pick && panels.show(c, { focus: true }));
    } else if (e.kind === 'asked' && !panels.isOpen(c.id)) {
      vscode.window
        .showInformationMessage(`Claude asked: ${e.question}${(e.added ?? 1) > 1 ? ` (+${(e.added ?? 1) - 1} more)` : ''}`, 'Show')
        .then((pick) => pick && panels.show(c, { focus: true }));
    }
    panels.update(c);
    refreshChrome();
  });
  store.prune(3 * 24 * 3600_000);

  /* ---------- server + registration ---------- */
  const token = randomBytes(24).toString('hex');
  ws = createWindowServer(store, token, log);
  const server = ws.server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const matchTerminals = async () => {
    if (!ws) return;
    const terms = await Promise.all(vscode.window.terminals.map(async (t) => ({ t, pid: await t.processId })));
    let changed = false;
    for (const sid of [...termFor.keys()])
      if (!ws.sessions.has(sid)) {
        termFor.delete(sid);
        changed = true;
      }
    for (const [sid, info] of ws.sessions) {
      const hit = terms.find((x) => x.pid && info.ancestors.includes(x.pid))?.t;
      if (termFor.get(sid) !== hit) {
        if (hit) termFor.set(sid, hit);
        else termFor.delete(sid);
        changed = true;
      }
    }
    if (changed) panels.refreshAll();
  };
  ws.onSessionsChange(() => {
    panels.refreshAll();
    matchTerminals();
  });
  ctx.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => matchTerminals()),
    vscode.window.onDidCloseTerminal(() => matchTerminals())
  );
  // Forget chats whose Claude has exited, so their Send now falls back to Copy for chat.
  const pruneTimer = setInterval(() => ws?.prune(), 20_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(pruneTimer) });
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
    vscode.commands.registerCommand('checklistBridge.startClaudeChannels', async () => {
      const pick = await vscode.window.showInformationMessage(
        'Start Claude Code with "Send now" switched on?',
        {
          modal: true,
          detail:
            'This opens a terminal running Claude Code with the checklist enabled as a channel, so "Send now" can hand your answers to Claude straight away, even while it is idle. ' +
            'Channels are a Claude Code research preview: Claude asks you to confirm the first time each session starts. ' +
            'In the Claude panel and in other terminals, "Send now" still works by typing into the terminal or by waiting.',
        },
        'Start Claude'
      );
      if (pick !== 'Start Claude') return;
      const term = vscode.window.createTerminal({ name: 'Claude (Send now)' });
      term.show();
      term.sendText('claude --dangerously-load-development-channels server:checklist');
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
      const demoSession = store.all().find((c) => c.title === 'Example checklist')?.sessionId;
      if (demoSession)
        store.handleTool(demoSession, {}, 'checklist_ask', {
          questions: [
            {
              question: 'Which example should Claude build next?',
              why: 'Questions like this appear when Claude needs a decision that can wait.',
              options: [
                { label: 'A login page', summary: 'Email and password, with a reset link', details: 'Takes about an hour. Needs a database table for users.' },
                { label: 'A settings page', summary: 'Theme and notification switches' },
              ],
              recommended: 'A login page',
              reason: 'Most other pages depend on it.',
            },
          ],
        });
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

  // Keep the managed CLAUDE.md instructions current with this version (only if the user set them up).
  try {
    if (isSetUp() && refreshInstructions()) log('Updated the Checklist Bridge instructions in CLAUDE.md.');
  } catch (e) {
    log(`Could not refresh CLAUDE.md instructions: ${e}`);
  }

  // Bring back checklists that were showing before the reload. VS Code hands most tabs back
  // itself (see the serializer above), so give it a moment and open only the ones still missing.
  refreshChrome();
  const reopen = setTimeout(() => {
    // VS Code may only hand a background tab back when it's clicked, so don't open a second
    // tab for a checklist that still has one waiting in the tab bar.
    const waiting = new Set(
      (vscode.window.tabGroups?.all ?? [])
        .flatMap((g) => g.tabs)
        .filter((t) => String((t.input as { viewType?: string } | undefined)?.viewType ?? '').endsWith(VIEW_TYPE))
        .map((t) => t.label)
    );
    for (const c of store.all()) if (!c.hidden && !panels.isOpen(c.id) && !waiting.has(c.title)) panels.show(c);
  }, 1500);
  ctx.subscriptions.push({ dispose: () => clearTimeout(reopen) });

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
  // The window is closing: tabs VS Code just closed weren't hidden by the user. Then save everything.
  try {
    for (const c of panelsRef?.undoShutdownCloses() ?? []) saveOne?.(c);
  } finally {
    flushSaves?.();
  }
  if (regTimer) clearInterval(regTimer);
  removeWindow(windowId, process.pid);
  ws?.server.close();
}
