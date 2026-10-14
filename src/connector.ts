// The MCP server Claude Code starts for each chat (stdio). It holds no state itself:
// every tool call is passed to the VS Code window this chat belongs to.
// It is also a Claude Code *channel*, so "Send now" in VS Code can push updates into the chat.
import * as http from 'http';
import * as readline from 'readline';
import { execFile } from 'child_process';
import { TOOLS, SERVER_INSTRUCTIONS, ToolResult } from './model';
import { pickWindow, readWindows, WindowInfo } from './registry';

const VERSION = '0.4.1';
const SERVER_NAME = process.env.CHECKLIST_BRIDGE_SERVER_NAME || 'checklist';
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// One checklist per chat: the parent process is the Claude Code session that spawned us,
// so its PID stays the same if Claude Code restarts this connector mid-chat.
const sessionId = `${process.env.CHECKLIST_BRIDGE_SESSION ?? ''}${process.ppid}-${cwd}`;
let client = 'claude';
let current: WindowInfo | undefined;

const log = (s: string) => process.stderr.write(`[checklist] ${s}\n`);

/* ------------------------------------------------------------ which process tree are we in? */

interface ProcInfo { ancestors: number[]; channel: boolean }
let procInfo: ProcInfo = { ancestors: [process.ppid], channel: false };

function processTable(): Promise<Map<number, { ppid: number; cmd: string }>> {
  return new Promise((resolve) => {
    const table = new Map<number, { ppid: number; cmd: string }>();
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
        { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (e, out) => {
          try {
            for (const p of JSON.parse(out)) table.set(p.ProcessId, { ppid: p.ParentProcessId, cmd: p.CommandLine ?? '' });
          } catch {
            /* fall back to parent only */
          }
          resolve(table);
        }
      );
    } else {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,args='], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (e, out) => {
        for (const line of String(out ?? '').split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s?(.*)$/);
          if (m) table.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[3] ?? '' });
        }
        resolve(table);
      });
    }
  });
}

async function detectProcess(): Promise<void> {
  const table = await processTable();
  const ancestors: number[] = [];
  let pid = process.ppid;
  let channel = false;
  for (let i = 0; i < 16 && pid > 1 && !ancestors.includes(pid); i++) {
    ancestors.push(pid);
    const p = table.get(pid);
    if (!p) break;
    // Claude Code started with this server opted in as a channel.
    if (/--(dangerously-load-development-)?channels\b/.test(p.cmd) && new RegExp(`server:${SERVER_NAME}\\b`).test(p.cmd)) channel = true;
    pid = p.ppid;
  }
  procInfo = { ancestors, channel };
  log(`Process chain ${ancestors.join(' > ')}${channel ? ' (channels on)' : ''}`);
  if (channel) pollLoop();
  // Tell the window right away, so "Send now" knows how to reach this chat before the next tool call.
  const w = windowFor(new Set());
  if (w) post(w, '/call', { sessionId, cwd, client, tool: '__hello', process: procInfo }, 5000).catch(() => {});
}

/* ------------------------------------------------------------ talking to the VS Code window */

function post(w: WindowInfo, path: string, body: object, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: w.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${w.token}`,
        },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200)
            // Refused before running (stale token, another app on that port): nothing happened.
            return reject(Object.assign(new Error(`window answered ${res.statusCode}`), { code: 'EREFUSEDCALL' }));
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

function windowFor(tried: Set<string>): WindowInfo | undefined {
  // Stay with the window we picked first, re-reading its file in case it reloaded on a new port.
  const w = current && readWindows().find((x) => x.windowId === current!.windowId);
  if (w && !tried.has(w.windowId)) return w;
  const pick = pickWindow(process.env, cwd, tried);
  if (pick) log(`Using VS Code window "${pick.w.name}" (${pick.why}).`);
  return pick?.w;
}

/** Errors that mean the request never reached a window. */
const NOT_DELIVERED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH', 'EREFUSEDCALL']);

async function call(tool: string, args: any, signal?: AbortSignal): Promise<ToolResult> {
  const tried = new Set<string>();
  const timeout = tool === 'checklist_wait' ? (Math.min(25, Math.max(1, Number(args?.timeout_minutes) || 20)) + 1) * 60_000 : 15_000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const w = windowFor(tried);
    if (!w) break;
    try {
      const result = await post(w, '/call', { sessionId, cwd, client, tool, args, process: procInfo }, timeout, signal);
      current = w;
      return result;
    } catch (e: any) {
      if (signal?.aborted) return { isError: true, content: [{ type: 'text', text: 'Cancelled.' }] };
      log(`Window "${w.name}" did not answer (${e.message}).`);
      // A window that never got the call (closed, reloaded on a new port) is safe to skip.
      // One that got it but was slow may have acted on it: trying another window would add the
      // same tasks or questions twice, so only read-only calls move on.
      if (!NOT_DELIVERED.has(e.code) && tool !== 'checklist_read')
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `The VS Code window "${w.name}" did not answer in time, so this ${tool} call may or may not have gone through. ` +
                'Call checklist_read to see the checklist before trying again.',
            },
          ],
        };
      tried.add(w.windowId);
      current = undefined;
    }
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          'The checklist could not be opened: no VS Code window with the Checklist Bridge extension is running. ' +
          'Ask the user to open VS Code (with the extension installed), then try again. Meanwhile, put the steps or question in your reply.',
      },
    ],
  };
}

/* ------------------------------------------------------------ channel: pushes from "Send now" */

let polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  for (;;) {
    const w = windowFor(new Set());
    if (!w) {
      await sleep(5000);
      continue;
    }
    try {
      const r = await post(w, '/poll', { sessionId, process: procInfo }, 40_000);
      current = w;
      for (const content of r.events ?? [])
        send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content, meta: { source: 'checklist' } } });
    } catch {
      current = undefined;
      await sleep(3000);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ MCP over stdio */

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const inflight = new Map<string | number, AbortController>();

async function handle(msg: any) {
  const id = msg?.id;
  const isRequest = id !== undefined && id !== null;
  const reply = (result: object) => isRequest && send({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => isRequest && send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (msg?.method) {
    case 'initialize':
      client = msg.params?.clientInfo?.name ?? client;
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'checklist-bridge', version: VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'notifications/cancelled':
      inflight.get(msg.params?.requestId)?.abort();
      return;
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      const ac = new AbortController();
      inflight.set(id, ac);
      // Long waits: send progress so Claude Code knows the call is alive.
      const token = msg.params?._meta?.progressToken;
      let tick = 0;
      const timer =
        name === 'checklist_wait' && token !== undefined
          ? setInterval(
              () =>
                send({
                  jsonrpc: '2.0',
                  method: 'notifications/progress',
                  params: { progressToken: token, progress: ++tick, message: 'Waiting for the user to share something in the checklist' },
                }),
              30_000
            )
          : undefined;
      try {
        return reply(await call(name, msg.params?.arguments ?? {}, ac.signal));
      } finally {
        if (timer) clearInterval(timer);
        inflight.delete(id);
      }
    }
    default:
      if (isRequest) fail(-32601, `Method not found: ${msg?.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) handle(m).catch((e) => log(String(e?.stack ?? e)));
});
rl.on('close', () => process.exit(0));

detectProcess().catch((e) => log(`Process detection failed: ${e}`));
