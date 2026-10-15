import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Checklist, ChecklistStore } from './model';
import { createWindowServer, WindowServer } from './windowServer';
import { ENV_WINDOW, ROOT, removeWindow, writeWindow } from './registry';
import { Panels, Routes, VIEW_TYPE } from './panels';
import { ChecklistTree } from './sidebar';
import { startUpdater } from './updater';
import { Saver } from './saver';
import { ImageFiles } from './images';
import { Ownership } from './ownership';
import { userSetting } from './settings';
import { addArgs, connect, disconnect, findClaude, findNode, needsRepair, registeredInConfig } from './claudeConnect';
import { applySetup, claudeDir, isSetUp, refreshInstructions, removeSetup } from './claudeSetup';

let ws: WindowServer | undefined;
let windowId = '';
let regTimer: NodeJS.Timeout | undefined;
let flushSaves: (() => void) | undefined;
let saveOne: ((c: Checklist) => void) | undefined;
let panelsRef: Panels | undefined;
let ownersRef: Ownership | undefined;

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
  const images = new ImageFiles(path.join(dir, 'images'), log);
  // Windows with no folder open share this storage, so each checklist belongs to one window.
  const owners = new Ownership(dir);
  ownersRef = owners;
  const initial: Checklist[] = [];
  const onDisk: string[] = []; // every checklist file, loaded or not, so their screenshots are kept
  const inlineImages: string[] = []; // saved by an older version, with screenshots inside the JSON
  let othersSkipped = 0;
  for (const n of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const id = n.slice(0, -'.json'.length);
    onDisk.push(id);
    if (!owners.claim(id)) {
      othersSkipped++;
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(dir, n), 'utf8');
      const c = JSON.parse(raw) as Checklist;
      if (raw.includes('"data":"')) inlineImages.push(c.id);
      images.index(c);
      initial.push(c);
    } catch (e) {
      owners.release(id);
      log(`Skipped an unreadable checklist file ${n}: ${e}`);
    }
  }
  if (othersSkipped) log(`${othersSkipped} checklist${othersSkipped === 1 ? ' belongs' : 's belong'} to another open window.`);
  try {
    images.cleanup(initial, onDisk);
  } catch (e) {
    log(`Could not clean up old screenshots: ${e}`);
  }
  const store = new ChecklistStore(initial);
  store.loadImage = (listId, img) => images.load(listId, img);
  const saver = new Saver(dir, (id) => {
    const c = store.get(id);
    return c && owners.owns(id) ? images.serialize(c) : undefined;
  }, log);
  // Convert checklists saved by older versions, moving their screenshots out into files.
  for (const id of inlineImages) saver.mark(id);
  const save = (c: Checklist) => saver.mark(c.id);
  flushSaves = () => saver.close();
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
  const panels = new Panels(store, ctx.extensionUri, { routes, sendNow }, images);
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
    vscode.commands.executeCommand('setContext', 'checklistBridge.hasChecklist', lists.length > 0);
    vscode.commands.executeCommand('setContext', 'checklistBridge.everyChat', isSetUp());
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
      owners.release(c.id);
      return refreshChrome();
    }
    if (e.kind === 'created') owners.claim(c.id); // new checklists belong to this window
    if (e.kind === 'created' && !c.sessionId.startsWith('demo-')) vscode.commands.executeCommand('setContext', 'checklistBridge.claudeUsed', true);
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

  /* ---------- connecting Claude Code ---------- */
  const INSTALL_URL = 'https://code.claude.com/docs/en/overview';
  const claudePath = () => userSetting('claudePath', '') || undefined;
  // Anthropic's Claude Code extension bundles its own `claude`, for people who never installed the CLI.
  const bundledIn = () => {
    const ext = vscode.extensions.getExtension('anthropic.claude-code') ?? vscode.extensions.getExtension('Anthropic.claude-code');
    return ext ? [ext.extensionPath] : [];
  };
  const q = (s: string) => (/[\s"'()&]/.test(s) ? `"${s}"` : s);
  const setupCommand = async () =>
    ['claude', ...addArgs(connectorPath, await findNode(), process.execPath)].map(q).join(' ');
  const setConnected = (on: boolean) => vscode.commands.executeCommand('setContext', 'checklistBridge.connected', on);
  /**
   * What the user last decided, so automatic connecting respects it:
   * never connected yet -> connect automatically; connected -> keep it; disconnected -> leave it alone.
   */
  type ConnectState = 'never' | 'connected' | 'disconnected';
  const connectState = (): ConnectState =>
    ctx.globalState.get<ConnectState>('connectState') ?? (ctx.globalState.get('connected') ? 'connected' : 'never');
  const setConnectState = (v: ConnectState) => ctx.globalState.update('connectState', v);
  setConnected(registeredInConfig(connectorPath));

  const afterConnect = (firstTime: boolean) => {
    setConnected(true);
    if (!firstTime) return;
    const more = isSetUp() ? [] : ['Make every chat use it'];
    vscode.window
      .showInformationMessage('Checklist Bridge is connected to Claude Code. Start a new Claude chat to use it.', ...more, 'Show an example')
      .then((p) => {
        if (p === 'Make every chat use it') vscode.commands.executeCommand('checklistBridge.setupClaude');
        if (p === 'Show an example') vscode.commands.executeCommand('checklistBridge.demo');
      });
  };

  /** Fallback: run the command in a terminal (its shell may find `claude` when VS Code can't), then watch for success. */
  const connectInTerminal = async () => {
    const term = vscode.window.createTerminal({ name: 'Connect Claude checklists' });
    term.show();
    term.sendText('claude mcp remove checklist --scope user');
    term.sendText(await setupCommand()); // presses Enter itself
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (registeredInConfig(connectorPath)) {
        clearInterval(timer);
        setConnectState('connected');
        afterConnect(true);
      } else if (Date.now() - t0 > 90_000) clearInterval(timer);
    }, 1500);
  };

  /** Connect without a terminal. Quiet when it works; explains what to do when it can't. */
  const ensureConnected = async (interactive: boolean) => {
    if (registeredInConfig(connectorPath)) {
      setConnected(true);
      if (interactive) vscode.window.showInformationMessage('Checklist Bridge is already connected to Claude Code.');
      return;
    }
    const outcome = await vscode.window.withProgress(
      { location: interactive ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title: 'Connecting Claude Code to your checklists…' },
      () => connect({ connectorPath, electronPath: process.execPath, claude: claudePath(), bundledIn: bundledIn() })
    );
    const firstTime = connectState() === 'never';
    if (outcome.status === 'connected') {
      log(`Connected Claude Code (${outcome.claude}).`);
      setConnectState('connected');
      afterConnect(firstTime || interactive);
      return;
    }
    setConnected(false);
    if (outcome.status === 'no-claude') {
      log('Could not find the claude command.');
      if (!interactive && ctx.globalState.get('toldNoClaude')) return; // don't nag on every start
      ctx.globalState.update('toldNoClaude', true);
      const p = await vscode.window.showWarningMessage(
        'Checklist Bridge works with Claude Code, but VS Code could not find it on this computer. Install Claude Code, then click Connect.',
        'Install Claude Code',
        'Connect',
        'Try in a terminal'
      );
      if (p === 'Install Claude Code') vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
      if (p === 'Connect') ensureConnected(true);
      if (p === 'Try in a terminal') connectInTerminal();
      return;
    }
    log(`Connecting failed using ${outcome.claude}: ${outcome.detail}`);
    if (!interactive && ctx.globalState.get('toldConnectFailed')) return;
    ctx.globalState.update('toldConnectFailed', true);
    const p = await vscode.window.showWarningMessage('Checklist Bridge could not connect to Claude Code automatically.', 'Try in a terminal', 'Show details');
    if (p === 'Try in a terminal') connectInTerminal();
    if (p === 'Show details') output.show();
  };

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
    vscode.commands.registerCommand('checklistBridge.connect', () => ensureConnected(true)),
    vscode.commands.registerCommand('checklistBridge.gettingStarted', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${ctx.extension?.id ?? 'Akshat270.checklist-bridge'}#start`, false)
    ),
    vscode.commands.registerCommand('checklistBridge.disconnect', async () => {
      const claude = await findClaude(process.env, undefined, claudePath(), bundledIn());
      if (claude) await disconnect(claude);
      setConnected(registeredInConfig(connectorPath));
      setConnectState('disconnected'); // don't reconnect by itself on the next start
      vscode.window.showInformationMessage(
        claude ? 'Disconnected. New Claude chats won\'t use checklists until you connect again.' : 'Could not find the claude command to disconnect.'
      );
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
        vscode.commands.executeCommand('setContext', 'checklistBridge.everyChat', true);
        vscode.window.showInformationMessage('Done. New Claude Code chats will use your checklist automatically.');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Couldn't update Claude Code's settings: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('checklistBridge.removeClaudeSetup', () => {
      try {
        const r = removeSetup(claudeDir());
        log(`Claude setup removed: instructions ${r.instructions}, permission ${r.permission}`);
        vscode.commands.executeCommand('setContext', 'checklistBridge.everyChat', false);
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
  if (store.all().some((c) => !c.sessionId.startsWith('demo-'))) vscode.commands.executeCommand('setContext', 'checklistBridge.claudeUsed', true);
  const reopen = setTimeout(() => {
    // VS Code may only hand a background tab back when it's clicked, so don't open a second
    // tab for a checklist that still has one waiting in the tab bar.
    // Tabs only carry a title, so count them: with two checklists named the same and one tab
    // waiting, the other one still gets opened.
    const waiting = new Map<string, number>();
    for (const t of (vscode.window.tabGroups?.all ?? []).flatMap((g) => g.tabs))
      if (String((t.input as { viewType?: string } | undefined)?.viewType ?? '').endsWith(VIEW_TYPE))
        waiting.set(t.label, (waiting.get(t.label) ?? 0) + 1);
    for (const c of store.all()) {
      if (c.hidden || panels.isOpen(c.id)) continue;
      const n = waiting.get(c.title) ?? 0;
      if (n > 0) waiting.set(c.title, n - 1);
      else panels.show(c);
    }
  }, 1500);
  ctx.subscriptions.push({ dispose: () => clearTimeout(reopen) });

  // Connect automatically the first time (or once Claude Code gets installed), keep a working connection
  // healthy, and respect the user's choice if they disconnected.
  const startupConnect = async () => {
    if (needsRepair(connectorPath)) {
      log('The runtime the Claude Code connection uses is gone; reconnecting.');
      const r = await connect({ connectorPath, electronPath: process.execPath, claude: claudePath(), bundledIn: bundledIn() });
      setConnected(r.status === 'connected');
      return;
    }
    if (registeredInConfig(connectorPath)) {
      setConnected(true);
      if (connectState() !== 'connected') setConnectState('connected');
      return;
    }
    setConnected(false);
    const state = connectState();
    if (state === 'never') return ensureConnected(false);
    if (state === 'disconnected') return;
    // It was connected, and the connection has been removed outside VS Code. Ask once; don't re-add it silently.
    setConnectState('disconnected');
    const p = await vscode.window.showInformationMessage(
      'Checklist Bridge is no longer connected to Claude Code (the connection was removed). Reconnect?',
      'Reconnect'
    );
    if (p === 'Reconnect') ensureConnected(true);
  };
  if (userSetting('autoConnect', true)) startupConnect();
  else {
    setConnected(registeredInConfig(connectorPath));
    if (!isSetUp() && !ctx.globalState.get('claudeSetupAsked') && connectState() === 'connected') {
      ctx.globalState.update('claudeSetupAsked', true);
      vscode.window
        .showInformationMessage('Want every Claude Code chat to use your checklist without being told?', 'Set up', 'Not now')
        .then((p) => p === 'Set up' && vscode.commands.executeCommand('checklistBridge.setupClaude'));
    }
  }
}

export function deactivate() {
  // The window is closing: tabs VS Code just closed weren't hidden by the user. Then save everything.
  try {
    for (const c of panelsRef?.undoShutdownCloses() ?? []) saveOne?.(c);
  } finally {
    flushSaves?.();
    ownersRef?.releaseAll(); // after saving, so the next window gets the final version
  }
  if (regTimer) clearInterval(regTimer);
  removeWindow(windowId, process.pid);
  ws?.server.close();
}
