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
export type Runner = (file: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

/** Runs a program without a shell (or through cmd.exe for .cmd/.bat files on Windows), quoting safely. */
export const run: Runner = (file, args, timeoutMs = 30_000) =>
  new Promise((resolve) => {
    const isBatch = WIN && /\.(cmd|bat)$/i.test(file);
    const quote = (s: string) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const [f, a, opts] = isBatch
      ? ['cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], { windowsVerbatimArguments: true }]
      : [file, args, {}];
    execFile(f, a, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts }, (e, stdout, stderr) =>
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
  // Set by the user (checklistBridge.claudePath) or, in tests, CHECKLIST_BRIDGE_CLAUDE ("none" = not installed).
  const explicit = configured || env.CHECKLIST_BRIDGE_CLAUDE;
  if (explicit) return explicit === 'none' ? undefined : explicit;
  const names = WIN ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean))
    for (const n of names) if (exists(path.join(dir, n))) return path.join(dir, n);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  for (const f of knownLocations(home, env)) if (exists(f)) return f;
  if (!WIN && env.SHELL) {
    const r = await runner(env.SHELL, ['-ilc', 'command -v claude'], 8000);
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
  const r = await runner(claude, ['mcp', 'get', SERVER], 20_000);
  return r.ok && r.out.includes(path.basename(path.dirname(connectorPath))) && r.out.includes('connector.js');
}

/** The `claude mcp add` arguments: Node if it's installed, otherwise VS Code's own runtime. */
export function addArgs(connectorPath: string, nodeAvailable: boolean, electronPath: string): string[] {
  return nodeAvailable
    ? ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER, '--', 'node', connectorPath]
    : ['mcp', 'add', '--env', 'ELECTRON_RUN_AS_NODE=1', '--transport', 'stdio', '--scope', 'user', SERVER, '--', electronPath, connectorPath];
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
  const node = (await runner('node', ['--version'], 5000)).ok;
  await runner(claude, ['mcp', 'remove', SERVER, '--scope', 'user'], 20_000); // an older setup, if any
  const r = await runner(claude, addArgs(opts.connectorPath, node, opts.electronPath), 30_000);
  if (await isConnected(opts.connectorPath, claude, env, runner)) return { status: 'connected', claude };
  return { status: 'failed', claude, detail: r.out.trim().slice(0, 500) || 'claude mcp add did not report an error, but the server is not registered.' };
}

/** Removes the registration. */
export async function disconnect(claude: string, runner: Runner = run) {
  return runner(claude, ['mcp', 'remove', SERVER, '--scope', 'user'], 20_000);
}
