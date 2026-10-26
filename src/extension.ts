import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Checklist, ChecklistStore, stillOpen } from './model';
import { createWindowServer, WindowServer } from './windowServer';
import { ENV_WINDOW, ROOT, removeWindow, writeWindow } from './registry';
import { Panels, Routes, VIEW_TYPE } from './panels';
import { ChecklistTree } from './sidebar';
import { startUpdater } from './updater';
import { Saver } from './saver';
import { ImageFiles } from './images';
import { Ownership } from './ownership';
import { userSetting } from './settings';
import { addArgs, connect, disconnect, findClaude, findNode, needsRepair, registeredInConfig, withLock } from './claudeConnect';
import { applySetup, claudeDir, isSetUp, refreshInstructions, removeSetup } from './claudeSetup';
import { modeFile } from './handover';
import { exportLists, hasShared, importLists, markMoved, readUse, sharedDirs, tidyShared, writeUse } from './switcher';

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
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(ctx.extensionUri.fsPath, 'package.json'), 'utf8')).version;
  } catch {
    /* keep 0.0.0 */
  }
  // The first line says which copy is running: a test build is loaded from your checkout, an installed one from the extensions folder.
  log(`Checklist Bridge ${version}, loaded from ${ctx.extensionUri.fsPath}`);

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
  const owners = new Ownership(dir, process.pid, windowId);
  ownersRef = owners;
  const initial: Checklist[] = [];
  const onDisk: string[] = []; // every checklist file, loaded or not, so their screenshots are kept
  const inlineImages: string[] = []; // saved by an older version, with screenshots inside the JSON
  const loaded = new Set<string>(); // ours already, or deleted here
  const retries = new Map<string, number>(); // files we hold but couldn't read yet (locked for a moment?)
  const read = (id: string, n: string, into: Checklist[]) => {
    try {
      const raw = fs.readFileSync(path.join(dir, n), 'utf8');
      const c = JSON.parse(raw) as Checklist;
      if (raw.includes('"data":"')) inlineImages.push(c.id);
      images.index(c);
      into.push(c);
      loaded.add(id);
      retries.delete(id);
    } catch (e) {
      const tries = (retries.get(id) ?? 0) + 1;
      retries.set(id, tries);
      if (tries === 1) log(`Could not read checklist file ${n}, will keep trying for a while: ${e}`);
    }
  };
  /** Reads every checklist file this window can take. Returns how many belong to another live window. */
  const loadFromDisk = (into: Checklist[], later = false) => {
    let skipped = 0;
    owners.observe();
    for (const n of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const id = n.slice(0, -'.json'.length);
      if (loaded.has(id)) continue;
      if (!onDisk.includes(id)) onDisk.push(id);
      if (retries.has(id)) {
        read(id, n, into); // its claim is ours, only reading it failed
        continue;
      }
      if (owners.owns(id)) continue; // created here since
      let mine = false;
      try {
        mine = owners.claim(id, later);
      } catch (e) {
        log(`Could not check who has checklist file ${n}: ${e}`);
      }
      if (!mine) {
        skipped++;
        continue;
      }
      read(id, n, into);
    }
    return skipped;
  };
  const othersSkipped = loadFromDisk(initial);
  let skippedLast = othersSkipped;
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
  const panels = new Panels(
    store,
    ctx.extensionUri,
    { routes, sendNow, locked: (c) => (store.lockedFor(c) ? 'Your checklists are in the Claude Code mod now, so this one is read-only here.' : undefined) },
    images
  );
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

  const noteClaudeUsed = (c: Checklist) => {
    if (!c.sessionId.startsWith('demo-')) vscode.commands.executeCommand('setContext', 'checklistBridge.claudeUsed', true);
  };

  store.onChange((e) => {
    const c = e.checklist;
    if (e.kind === 'removed') {
      loaded.add(c.id); // deleted here: never read it back, even if its file lingers
      retries.delete(c.id);
      saver.remove(c.id);
      owners.release(c.id);
      return refreshChrome();
    }
    if (e.kind === 'created') owners.claim(c.id); // new checklists belong to this window
    if (e.kind === 'created') noteClaudeUsed(c);
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
  // End "away" when the time the user gave runs out. Claude is not woken for this: an idle chat's cache
  // has usually expired by then, so waking it would cost the user. It finds out on its next read.
  const awayTick = process.env.CHECKLIST_BRIDGE_TEST === '1' ? Number(process.env.CHECKLIST_BRIDGE_AWAY_TICK_MS) || 15_000 : 15_000;
  const awayTimer = setInterval(() => {
    try {
      store.expireAway(); // not the ones the mod has: it ends their aways
    } catch (e) {
      log(`Could not end an away: ${e}`); // one bad listener must not stop the timer or crash the window
    }
  }, awayTick);
  ctx.subscriptions.push({ dispose: () => clearInterval(awayTimer) });
  let focusedAt = vscode.window.state.focused ? Date.now() : 0;
  let onFocus = () => {}; // set below, once switching to the Claude Code mod is set up
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
    for (const f of ['connector.js', 'model.js', 'registry.js', 'handover.js'])
      fs.copyFileSync(path.join(path.dirname(connectorSrc), f), path.join(connectorDir, f));
  } catch (e) {
    log(`Could not copy the connector: ${e}`);
  }

  /* ---------- connecting Claude Code ---------- */
  const INSTALL_URL = 'https://code.claude.com/docs/en/overview';
  const connectLock = path.join(ROOT, 'connect.lock'); // one window connects at a time
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
  // Set when switching to the mod removed the connection, so coming back reconnects instead of asking.
  const GONE_FOR_MOD = 'disconnectedForMod';
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
    const attempt = () =>
      vscode.window.withProgress(
        { location: interactive ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title: 'Connecting Claude Code to your checklists…' },
        () => withLock(connectLock, () => connect({ connectorPath, electronPath: process.execPath, claude: claudePath(), bundledIn: bundledIn() }))
      );
    let r = await attempt();
    if (!r.ran) {
      // Another window was connecting at the same time. If it worked, we're done, quietly.
      if (registeredInConfig(connectorPath)) {
        setConnected(true);
        setConnectState('connected');
        if (interactive) vscode.window.showInformationMessage('Checklist Bridge is connected to Claude Code.');
        return;
      }
      r = await attempt(); // it didn't: try ourselves
      if (!r.ran) return;
    }
    const outcome = r.value;
    const firstTime = connectState() === 'never';
    if (outcome.status === 'connected') {
      log(`Connected Claude Code (${outcome.claude}).`);
      setConnectState('connected');
      ctx.globalState.update(GONE_FOR_MOD, undefined);
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
        onFocus();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(register),

    // Not offered anywhere any more (a click now always opens), kept so a keybinding someone made for it still works.
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
      const refuseLocked = async () => {
        const pick = await vscode.window.showInformationMessage(
          'Your checklists are in the Claude Code mod now, so this one is read-only here. Switch back to VS Code to close it.',
          'Switch back to VS Code'
        );
        if (pick) vscode.commands.executeCommand('checklistBridge.useExtension');
      };
      if (store.lockedFor(c)) return refuseLocked();
      await panels.flush(c.id); // an answer picked or typed a moment ago in its panel counts in what is still waiting
      const pick = await vscode.window.showWarningMessage(
        `Close "${c.title}"?`,
        { modal: true, detail: stillOpen(c) + 'Claude will be told the checklist was closed. If it adds tasks later, a new checklist opens.' },
        'Close checklist'
      );
      if (pick !== 'Close checklist') return;
      // The window may have handed it to the mod while the question was open.
      if (store.lockedFor(c)) return refuseLocked();
      store.close(c.id);
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
    vscode.commands.registerCommand('checklistBridge.connect', () =>
      // Connecting while the Claude Code mod is on would give Claude two checklists: switch back instead.
      readUse(ROOT) === 'mod' ? vscode.commands.executeCommand('checklistBridge.useExtension') : ensureConnected(true)
    ),
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
  // Open a tab for each of these checklists that should have one.
  const reopenTabs = (lists: Checklist[]) => {
    // VS Code may only hand a background tab back when it's clicked, so don't open a second
    // tab for a checklist that still has one waiting in the tab bar.
    // Tabs only carry a title, so count them: with two checklists named the same and one tab
    // waiting, the other one still gets opened.
    const waiting = new Map<string, number>();
    for (const t of (vscode.window.tabGroups?.all ?? []).flatMap((g) => g.tabs))
      if (String((t.input as { viewType?: string } | undefined)?.viewType ?? '').endsWith(VIEW_TYPE))
        waiting.set(t.label, (waiting.get(t.label) ?? 0) + 1);
    // Tabs of checklists we have open are not waiting for anything.
    for (const id of panels.openIds()) {
      const t = store.get(id)?.title;
      if (t && waiting.get(t)) waiting.set(t, waiting.get(t)! - 1);
    }
    for (const c of lists) {
      if (c.hidden || c.closed || panels.isOpen(c.id)) continue;
      const n = waiting.get(c.title) ?? 0;
      if (n > 0) waiting.set(c.title, n - 1);
      else panels.show(c);
    }
  };
  const reopen = setTimeout(() => reopenTabs(store.all()), 1500);
  ctx.subscriptions.push({ dispose: () => clearTimeout(reopen) });
  // After a reload the old window may still hold its checklists for a moment. Keep looking, and take
  // each one as soon as it is free, so a checklist never goes missing because we asked too early.
  // Only checklists last held by this same window (same folder). Windows without a folder have no
  // stable identity, and there a closing window's checklists go to the next window that starts.
  // Keep looking while there is something to wait for: a checklist the old window still holds, or a
  // file we couldn't read yet. Every 2 s for the first minute, then every 30 s, for up to 10 minutes.
  // Only windows with a stable id can take back what an earlier copy of them held; folderless ones
  // just retry their own unreadable files.
  const lookStart = Date.now();
  const stable = !windowId.startsWith('empty-');
  let lookTimer: NodeJS.Timeout | undefined;
  const scheduleLook = () => {
    const age = Date.now() - lookStart;
    if (!(retries.size > 0 || (stable && (skippedLast > 0 || owners.waitingOn() > 0)))) return;
    if (age > 10 * 60_000) return void (retries.size && log(`Gave up reading ${retries.size} checklist file(s).`));
    lookTimer = setTimeout(lookAgain, age < 60_000 ? 2000 : 30_000);
  };
  const lookAgain = () => {
    try {
      const more: Checklist[] = [];
      skippedLast = loadFromDisk(more, true);
      const adopted: Checklist[] = [];
      for (const c of more) {
        const mine = store.adopt(c);
        if (!mine) continue;
        noteClaudeUsed(mine);
        adopted.push(mine);
      }
      reopenTabs(adopted);
    } catch (e) {
      log(`Could not look for checklists: ${e}`);
    }
    scheduleLook();
  };
  scheduleLook();
  ctx.subscriptions.push({ dispose: () => lookTimer && clearTimeout(lookTimer) });

  // Connect automatically the first time (or once Claude Code gets installed), keep a working connection
  // healthy, and respect the user's choice if they disconnected.
  const startupConnect = async () => {
    if (needsRepair(connectorPath)) {
      log('The runtime the Claude Code connection uses is gone; reconnecting.');
      const r = await withLock(connectLock, () => connect({ connectorPath, electronPath: process.execPath, claude: claudePath(), bundledIn: bundledIn() }));
      setConnected(r.ran ? r.value.status === 'connected' : registeredInConfig(connectorPath));
      return;
    }
    if (registeredInConfig(connectorPath)) {
      setConnected(true);
      if (connectState() !== 'connected') setConnectState('connected');
      return;
    }
    setConnected(false);
    const state = connectState();
    // Never connected, or the connection was removed when switching to the mod: connect without asking.
    if (state === 'never' || ctx.globalState.get(GONE_FOR_MOD)) return ensureConnected(false);
    if (state === 'disconnected') return;
    // It was connected, and the connection has been removed outside VS Code. Ask once; don't re-add it silently.
    setConnectState('disconnected');
    const p = await vscode.window.showInformationMessage(
      'Checklist Bridge is no longer connected to Claude Code (the connection was removed). Reconnect?',
      'Reconnect'
    );
    if (p === 'Reconnect') ensureConnected(true);
  };

  /* ---------- switching to the Claude Code mod and back (switcher.ts, handover.ts) ---------- */
  // ~/.checklist-bridge/mode.json says which one is on. Either side can change it; this window follows it
  // when it starts and whenever it gets focus. The checklists of this folder go with the switch.
  const project = folders[0];
  const MOD_INSTALL = '/plugin install checklist-bridge --marketplace Akshat270/checklist-bridge';
  // This window gave its checklists to the mod. Folderless windows get a new id each start, so they share one key.
  const windowKey = windowId.startsWith('empty-') ? 'empty' : windowId;
  const handedKey = `handedToMod:${windowKey}`;
  const handedAtKey = `handedAt:${windowKey}`; // each handed-over checklist's updatedAt, to tell if the mod changed it
  const keptKey = `keptHere:${windowKey}`; // checklists that could not be handed over, so stay usable here
  // While the mod has the checklists, this window changes none of them: chats still connected to it get
  // this instead, and its panels say so (see panels.ts). Otherwise their changes would be lost on the way back.
  // A window with no folder open hands nothing over (the mod keeps checklists per folder), so it stays editable,
  // and so do checklists that could not be handed over (`kept`).
  let lockedOn = false;
  const lock = (on: boolean, kept: string[] = []) => {
    lockedOn = on;
    store.lockedNote = on && project
      ? 'The user switched Checklist Bridge to its Claude Code mod, so this checklist is read-only here. ' +
        'Put the steps or the question in your reply instead; in a new chat Claude uses the mod\'s checklist.'
      : undefined;
    store.keptHere = new Set(on ? kept : []);
    // A chat waiting on its checklist would otherwise wait out its full time for an update that can't come.
    if (store.lockedNote) ws?.endWaits(store.lockedNote);
    vscode.commands.executeCommand('setContext', 'checklistBridge.modMode', on);
    panels.refreshAll();
  };
  const handOver = async () => {
    let n = 0;
    const handedAt: Record<string, number> = {};
    let kept: string[] = [];
    const ours = () => store.all().filter((c) => !c.sessionId.startsWith('demo-'));
    if (project) {
      // What was typed in a panel a moment ago goes along too (the panel holds typing back briefly).
      await Promise.all(ours().map((c) => panels.flush(c.id)));
      // From here to lock() nothing waits, so no tool call can change a checklist after it was written.
      const lists = ours();
      const r = exportLists(ROOT, project, lists, images);
      n = r.written;
      kept = r.failed.map((c) => c.id);
      for (const c of lists) if (!kept.includes(c.id)) handedAt[c.id] = c.updatedAt;
      if (r.failed.length) {
        log(`Could not hand these checklists to the Claude Code mod: ${r.failed.map((c) => c.title).join(', ')}`);
        vscode.window.showWarningMessage(
          `Checklist Bridge could not move ${r.failed.length === 1 ? `"${r.failed[0].title}"` : `${r.failed.length} checklists`} to the Claude Code mod. ` +
            `${r.failed.length === 1 ? 'It stays' : 'They stay'} here in VS Code, and you can still use ${r.failed.length === 1 ? 'it' : 'them'} here.`
        );
      }
    } else if (ours().length) {
      // The mod keeps checklists per folder, so a window with no folder open has nowhere to hand them. They
      // stay here, and stay editable: nothing else has a copy.
      vscode.window.showInformationMessage('This window has no folder open, so its checklists stay here in VS Code. Open the project folder to move them to the Claude Code mod.');
    }
    lock(true, kept);
    await ctx.globalState.update(handedKey, true);
    await ctx.globalState.update(handedAtKey, handedAt);
    await ctx.globalState.update(keptKey, kept);
    if (registeredInConfig(connectorPath)) {
      const claude = await findClaude(process.env, undefined, claudePath(), bundledIn());
      if (claude) await withLock(connectLock, () => disconnect(claude));
      setConnected(registeredInConfig(connectorPath));
      if (!registeredInConfig(connectorPath)) await ctx.globalState.update(GONE_FOR_MOD, true);
    }
    log(`Switched to the Claude Code mod; handed over ${n} checklist(s).`);
    return n;
  };
  const takeBack = async () => {
    let n = 0;
    // This window's folders, and the subfolders mod chats were started in.
    const dirs = sharedDirs(ROOT, folders).filter(hasShared);
    const handedAt = ctx.globalState.get<Record<string, number>>(handedAtKey) ?? {};
    const changed: Checklist[] = [];
    for (const dir of dirs) {
      const { lists, ids } = importLists(dir);
      for (const c of lists) {
        const mine = store.get(c.id);
        // Taken in only if the mod changed it: newer than what we handed over, or (no handover to go by: a file
        // left behind, or one a mod chat saved late) newer than ours. So a stale file never undoes edits here.
        if (mine && c.updatedAt <= (handedAt[c.id] ?? mine.updatedAt)) continue;
        if (!mine && c.closed) continue; // made and closed in the mod: nothing to bring back
        owners.claim(c.id);
        if (!c.closed) c.hidden = false; // the user just worked on it in the mod: show it, even if its tab was closed here
        store.replace(c); // closed in the mod: closed here too
        if (!c.closed) changed.push(store.get(c.id)!);
        n++;
      }
      const left = markMoved(dir, ids);
      if (left.length) log(`Could not mark these checklist files as moved (they stay unless the mod changes them): ${left.join(', ')}`);
    }
    reopenTabs(changed); // only what the mod changed or made; tabs the user had closed stay closed
    try {
      const gone = tidyShared(ROOT);
      if (gone) log(`Deleted ${gone} old file(s) the Claude Code mod no longer uses.`);
    } catch (e) {
      log(`Could not tidy the Claude Code mod's folder: ${e}`);
    }
    lock(false);
    await ctx.globalState.update(handedAtKey, undefined);
    await ctx.globalState.update(keptKey, undefined);
    if (ctx.globalState.get(handedKey) || n) {
      await ctx.globalState.update(handedKey, false);
      // Put back the connection switching to the mod removed; otherwise connect only if the user lets us.
      if (ctx.globalState.get(GONE_FOR_MOD) || userSetting('autoConnect', true)) await ensureConnected(false);
    }
    if (n) vscode.window.showInformationMessage(`Your checklist${n === 1 ? ' is' : 's are'} back in VS Code from the Claude Code mod.`);
    return n;
  };
  // One switch at a time. Closing a switch command's dialog gives the window focus, and a focus event while a
  // switch is running or waiting must not start a second handover or take-back: it is dropped. The commands
  // wait their turn.
  let switching: Promise<unknown> = Promise.resolve();
  let inLine = 0;
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    inLine++;
    const run = switching.then(work).finally(() => inLine--);
    switching = run.catch(() => {});
    return run;
  };
  // A change seen while a switch runs or waits is looked at again once it is done (the mode file's watcher
  // fires once, and the window may never lose focus), so the window always ends up as mode.json says.
  let modeChanged = false;
  const followMode = (): Promise<unknown> => {
    if (inLine) {
      modeChanged = true;
      return switching;
    }
    return oneAtATime(followModeNow).finally(() => {
      if (!modeChanged) return;
      modeChanged = false;
      void followMode();
    });
  };
  async function followModeNow() {
    try {
      const use = readUse(ROOT);
      if (use === 'mod') {
        if (ctx.globalState.get(handedKey)) {
          if (!lockedOn) lock(true, ctx.globalState.get<string[]>(keptKey)); // once, not on every focus
          return;
        }
        const n = await handOver();
        // Not awaited: while it waits for the user, this window must still follow the next switch.
        vscode.window
          .showInformationMessage(
            `Checklist Bridge runs inside Claude Code now.${n ? ` ${n} checklist${n === 1 ? '' : 's'} from this folder moved there.` : ''} Type /checklist in Claude Code to see it.`,
            'Switch back to VS Code'
          )
          .then((p) => p && vscode.commands.executeCommand('checklistBridge.useExtension'));
      } else {
        let now = use;
        if (use === undefined && registeredInConfig(connectorPath)) writeUse(ROOT, (now = 'extension'));
        // With no choice made and the extension not connected (auto-connect off, or the user disconnected it),
        // the mod is the one in use: leave its checklists there.
        if (ctx.globalState.get(handedKey) || (now === 'extension' && sharedDirs(ROOT, folders).some(hasShared))) await takeBack();
      }
    } catch (e) {
      log(`Could not switch between the extension and the Claude Code mod: ${e}`);
    }
  }
  onFocus = () => void followMode();
  // The switch is often made in this window's own terminal (Claude Code in VS Code), so the window never
  // loses focus to notice it: watch the mode file too. Polled, which works the same on every system.
  const modePath = modeFile(ROOT);
  fs.watchFile(modePath, { interval: 1500, persistent: false }, () => void followMode());
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(modePath) });
  ctx.subscriptions.push(
    vscode.commands.registerCommand('checklistBridge.useMod', async () => {
      const pick = await vscode.window.showInformationMessage(
        'Use Checklist Bridge inside Claude Code instead of VS Code?',
        {
          modal: true,
          detail:
            'Your checklists for this folder move to the Checklist Bridge mod for Claude Code, and Claude stops using this extension. ' +
            `Install the mod by typing this in Claude Code:\n\n${MOD_INSTALL}\n\nYou can switch back any time.`,
        },
        'Switch'
      );
      if (pick !== 'Switch') return;
      const n = await oneAtATime(async () => {
        // Already handed over (this window followed the mod's /checklist use-mod): doing it again would only
        // write our read-only copies over what the user has done in the mod since.
        if (readUse(ROOT) === 'mod' && ctx.globalState.get(handedKey)) return undefined;
        writeUse(ROOT, 'mod');
        await ctx.globalState.update(handedKey, false);
        return handOver();
      });
      const p = await vscode.window.showInformationMessage(
        n === undefined
          ? `Checklist Bridge already runs inside Claude Code. If the mod isn't installed yet, type ${MOD_INSTALL} in Claude Code.`
          : `Done${n ? `: ${n} checklist${n === 1 ? '' : 's'} moved` : ''}. In Claude Code, type ${MOD_INSTALL}, then start a new chat.`,
        'Copy the command'
      );
      if (p) await vscode.env.clipboard.writeText(MOD_INSTALL);
    }),
    vscode.commands.registerCommand('checklistBridge.useExtension', async () => {
      await oneAtATime(async () => {
        writeUse(ROOT, 'extension');
        await ctx.globalState.update(handedKey, true); // reconnect even if nothing comes back
        await takeBack();
      });
      vscode.window.showInformationMessage('Checklist Bridge runs in VS Code again. Start a new Claude chat to use it.');
    })
  );

  // Back from the mod while VS Code was closed: take the checklists back and reconnect, rather than
  // startupConnect asking whether to reconnect a connection that "was removed".
  if (readUse(ROOT) === 'mod' || ctx.globalState.get(handedKey)) followMode();
  else if (userSetting('autoConnect', true)) startupConnect().then(followMode);
  else {
    followMode();
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
