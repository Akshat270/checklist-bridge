// The MCP server Claude Code starts for each chat (stdio). It holds no state itself:
// every tool call is passed to the VS Code window this chat belongs to.
import * as http from 'http';
import * as readline from 'readline';
import { TOOLS, SERVER_INSTRUCTIONS, ToolResult } from './model';
import { pickWindow, readWindows, WindowInfo } from './registry';

const VERSION = '0.2.3';
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// One checklist per chat: the parent process is the Claude Code session that spawned us,
// so its PID stays the same if Claude Code restarts this connector mid-chat.
const sessionId = `${process.env.CHECKLIST_BRIDGE_SESSION ?? ''}${process.ppid}-${cwd}`;
let client = 'claude';
let current: WindowInfo | undefined;

const log = (s: string) => process.stderr.write(`[checklist] ${s}\n`);

function post(w: WindowInfo, body: object): Promise<ToolResult> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: w.port,
        path: '/call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${w.token}`,
        },
        timeout: 15_000,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`window answered ${res.statusCode}`));
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

async function call(tool: string, args: unknown): Promise<ToolResult> {
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    // Stay with the window we picked first, re-reading its file in case it reloaded on a new port.
    let w = current && readWindows().find((x) => x.windowId === current!.windowId);
    if (!w) {
      const pick = pickWindow(process.env, cwd, tried);
      if (!pick) break;
      w = pick.w;
      log(`Using VS Code window "${w.name}" (${pick.why}).`);
    }
    try {
      const result = await post(w, { sessionId, cwd, client, tool, args });
      current = w;
      return result;
    } catch (e: any) {
      log(`Window "${w.name}" did not answer (${e.message}).`);
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
          'Ask the user to open VS Code (with the extension installed), then try again. Meanwhile, give the steps in your reply.',
      },
    ],
  };
}

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

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
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'checklist-bridge', version: VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      return reply(await call(name, msg.params?.arguments ?? {}));
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
