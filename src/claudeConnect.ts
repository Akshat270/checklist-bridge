// Connects Claude Code to the checklist connector without a terminal: finds the `claude` command,
// runs `claude mcp add ... --scope user`, and checks that it worked. No `vscode` import, so it can be
// tested on its own.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

export const SERVER = 'checklist';
const WIN = process.platform === 'win32';

export interface RunResult { ok: boolean; out: string }
export type Runner = (file: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv) => Promise<RunResult>;

/** Runs a program without a shell (or through cmd.exe for .cmd/.bat files on Windows), quoting safely. */
export const run: Runner = (file, args, timeoutMs = 30_000, env = process.env) =>
  new Promise((resolve) => {
    const isBatch = WIN && /\.(cmd|bat)$/i.test(file);
    // Quote for cmd.exe; a % is put outside the quotes and escaped (^%) so it isn't read as a %VARIABLE%.
    const quote = (s: string) =>
      /[\s"&|<>^()%]/.test(s) ? s.split('%').map((part) => `"${part.replace(/"/g, '""')}"`).join('^%') : s;
    // Use Windows' own command processor by full path, not whatever "cmd.exe" PATH finds (if any).
    const cmd = env.ComSpec || process.env.ComSpec || path.join(env.SystemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const [f, a, opts] = isBatch
      ? [cmd, ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], { windowsVerbatimArguments: true }]
      : [file, args, {}];
    execFile(f, a, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env, ...opts }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: `${stdout ?? ''}${stderr ?? ''}${e && !stdout && !stderr ? String(e.message) : ''}` })
    );
  });

const exists = (f: string) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/** Places the `claude` command is commonly installed, beyond PATH. */
function knownLocations(home: string, env: NodeJS.ProcessEnv): string[] {
  const out = [
    path.join(home, '.local', 'bin', WIN ? 'claude.exe' : 'claude'), // native installer
    path.join(home, '.claude', 'local', WIN ? 'claude.exe' : 'claude'), // older local install
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', WIN ? 'claude.exe' : 'claude'),
  ];
  if (WIN) {
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'claude.cmd'));
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  } else {
    out.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude');
  }
  return out;
}

/**
 * Finds the `claude` command: PATH first, then usual install locations, then (macOS/Linux) the
 * user's login shell, whose PATH can be fuller than the one VS Code was started with.
 */
/** Looks a few levels down a folder (e.g. Anthropic's Claude Code VS Code extension) for a bundled `claude`. */
export function findInFolder(root: string, depth = 4): string | undefined {
  const want = WIN ? ['claude.exe'] : ['claude'];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) if (e.isFile() && want.includes(e.name)) return path.join(root, e.name);
  if (depth > 0)
    for (const e of entries)
      if (e.isDirectory() && e.name !== 'node_modules') {
        const f = findInFolder(path.join(root, e.name), depth - 1);
        if (f) return f;
      }
  return undefined;
}

export async function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  runner: Runner = run,
  configured?: string,
  bundledIn: string[] = []
): Promise<string | undefined> {
  // Set by the user (checklistBridge.claudePath), or in the test suite only, CHECKLIST_BRIDGE_CLAUDE ("none" = not installed).
  const explicit = configured || (env.CHECKLIST_BRIDGE_TEST === '1' ? env.CHECKLIST_BRIDGE_CLAUDE : undefined);
  if (explicit) return explicit === 'none' ? undefined : explicit;
  const names = WIN ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean))
    for (const n of names) if (exists(path.join(dir, n))) return path.join(dir, n);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  for (const f of knownLocations(home, env)) if (exists(f)) return f;
  if (!WIN && env.SHELL) {
    const r = await runner(env.SHELL, ['-ilc', 'command -v claude'], 8000, env);
    const found = r.out.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('/') && exists(l));
    if (found) return found;
  }
  // Last resort: the copy bundled with Anthropic's Claude Code extension for VS Code.
  for (const dir of bundledIn) {
    const f = findInFolder(dir);
    if (f) return f;
  }
  return undefined;
}

/** Where Claude Code keeps user-level settings, including user-scope MCP servers. */
export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude.json');
}

/** Finds a program on PATH (node, node.exe…). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = WIN ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean))
    for (const n of names) if (exists(path.join(dir, n))) return path.join(dir, n);
  return undefined;
}

/** Our server's entry in Claude Code's user settings, if any. */
export function registration(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(claudeJsonPath(env), 'utf8'))?.mcpServers?.[SERVER];
    return s && typeof s.command === 'string' && Array.isArray(s.args) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Registered, but the program it runs is gone (Node upgraded or uninstalled): needs re-registering. */
export function needsRepair(connectorPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const r = registration(env);
  return !!r && registeredInConfig(connectorPath, env) && path.isAbsolute(r.command) && !exists(r.command);
}

/** Quick check without running anything: is our connector registered as a user-scope server? */
export function registeredInConfig(connectorPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(claudeJsonPath(env), 'utf8'));
    const s = cfg?.mcpServers?.[SERVER];
    return !!s && Array.isArray(s.args) && s.args.some((a: unknown) => typeof a === 'string' && path.resolve(a) === path.resolve(connectorPath));
  } catch {
    return false;
  }
}

/** Is Claude Code connected to this connector? Reads the config, and asks `claude` if that's inconclusive. */
export async function isConnected(connectorPath: string, claude?: string, env: NodeJS.ProcessEnv = process.env, runner: Runner = run) {
  if (registeredInConfig(connectorPath, env)) return true;
  if (!claude) return false;
  const r = await runner(claude, ['mcp', 'get', SERVER], 20_000, env);
  return r.ok && r.out.includes(path.basename(path.dirname(connectorPath))) && r.out.includes('connector.js');
}

/**
 * The `claude mcp add` arguments. Uses Node by its full path when it's installed, so the connection
 * works however Claude Code was started (its PATH may differ); otherwise VS Code's own runtime.
 */
export function addArgs(connectorPath: string, nodePath: string | undefined, electronPath: string): string[] {
  return nodePath
    ? ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER, '--', nodePath, connectorPath]
    : ['mcp', 'add', '--env', 'ELECTRON_RUN_AS_NODE=1', '--transport', 'stdio', '--scope', 'user', SERVER, '--', electronPath, connectorPath];
}

/** Full path to a working Node.js, if there is one. */
export async function findNode(env: NodeJS.ProcessEnv = process.env, runner: Runner = run): Promise<string | undefined> {
  const node = findOnPath('node', env);
  return node && (await runner(node, ['--version'], 5000, env)).ok ? node : undefined;
}

export type ConnectOutcome =
  | { status: 'connected'; claude: string }
  | { status: 'no-claude' }
  | { status: 'failed'; claude: string; detail: string };

/** Registers the connector with Claude Code (replacing an older registration) and verifies it. */
export async function connect(opts: {
  connectorPath: string;
  electronPath: string;
  claude?: string;
  bundledIn?: string[];
  env?: NodeJS.ProcessEnv;
  runner?: Runner;
}): Promise<ConnectOutcome> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? run;
  const claude = await findClaude(env, runner, opts.claude, opts.bundledIn);
  if (!claude) return { status: 'no-claude' };
  const node = await findNode(env, runner);
  await runner(claude, ['mcp', 'remove', SERVER, '--scope', 'user'], 20_000, env); // an older setup, if any
  const r = await runner(claude, addArgs(opts.connectorPath, node, opts.electronPath), 30_000, env);
  if (await isConnected(opts.connectorPath, claude, env, runner)) return { status: 'connected', claude };
  return { status: 'failed', claude, detail: r.out.trim().slice(0, 500) || 'claude mcp add did not report an error, but the server is not registered.' };
}

/** Removes the registration. */
export async function disconnect(claude: string, runner: Runner = run, env: NodeJS.ProcessEnv = process.env) {
  return runner(claude, ['mcp', 'remove', SERVER, '--scope', 'user'], 20_000, env);
}

/**
 * Runs `fn` while holding a lock file shared by every VS Code window on this computer, so only one
 * window connects at a time (installing activates the extension in all open windows at once).
 * If another window holds the lock, waits for it to finish and returns { ran: false } without running
 * `fn`: the caller should look at the result of that window's work instead. A lock left by a window that
 * died, or older than two minutes, is taken over.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, waitMs = 90_000): Promise<{ ran: true; value: T } | { ran: false }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === 'EPERM';
    }
  };
  const t0 = Date.now();
  let waited = false;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      break; // we hold it
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
    let holder: { pid?: number; at?: number } = {};
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* being written or just removed */
    }
    const stale = holder.pid !== undefined && (!alive(holder.pid) || Date.now() - (holder.at ?? 0) > 120_000);
    if (stale) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() - t0 > waitMs) return { ran: false };
    waited = true;
    await new Promise((r) => setTimeout(r, 250));
    if (waited && !fs.existsSync(file)) return { ran: false }; // the other window is done
  }
  try {
    return { ran: true, value: await fn() };
  } finally {
    fs.rmSync(file, { force: true });
  }
}
