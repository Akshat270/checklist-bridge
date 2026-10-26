// Local HTTP endpoint inside each VS Code window. The per-chat connector posts tool calls here,
// waits here (checklist_wait), and long-polls here for pushed updates (channels).
import * as http from 'http';
import { timingSafeEqual } from 'crypto';
import { ChecklistStore, ToolResult } from './model';

export interface SessionInfo {
  /** Process ids from the connector's parent upwards (Claude Code, its shell, terminal...). */
  ancestors: number[];
  /** Claude Code was started with channels enabled for this server. */
  channel: boolean;
  /** The connector is currently long-polling for pushes (channel delivery is live). */
  polling: boolean;
  lastCall: number;
  /** When the chat last called or polled. */
  lastSeen: number;
}

export interface WindowServer {
  server: http.Server;
  sessions: Map<string, SessionInfo>;
  isWaiting(sessionId: string): boolean;
  /** The chat's Claude Code process is still running (unknown counts as alive). */
  isAlive(sessionId: string): boolean;
  /** Forget chats whose Claude Code process has exited. Returns true if any were dropped. */
  prune(): boolean;
  /** Queue a channel message for this chat. Returns false if no connector is listening. */
  push(sessionId: string, content: string): boolean;
  /** Ends every checklist_wait under way with this text (the checklists were handed to the Claude Code mod). */
  endWaits(text: string): void;
  onSessionsChange(fn: () => void): void;
}

const MAX_WAIT_MIN = 25;

export function createWindowServer(store: ChecklistStore, token: string, log: (s: string) => void = () => {}): WindowServer {
  const expected = Buffer.from(`Bearer ${token}`);
  const sessions = new Map<string, SessionInfo>();
  type Waiter = ((r: ToolResult) => void) & { res?: http.ServerResponse };
  const waiters = new Map<string, Set<Waiter>>();
  const polls = new Map<string, (events: string[]) => void>();
  const queued = new Map<string, string[]>();
  const changeFns: (() => void)[] = [];
  const changed = () => changeFns.forEach((f) => f());

  const session = (id: string): SessionInfo => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { ancestors: [], channel: false, polling: false, lastCall: 0, lastSeen: 0 }));
    return s;
  };

  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === 'EPERM';
    }
  };
  // A chat that gives no process (the Claude Code mod passing calls on after a switch) is alive while it keeps
  // coming back: it polls at least every half minute.
  const QUIET_MS = 2 * 60_000;
  const isAlive = (id: string) => {
    const s = sessions.get(id);
    const pid = s?.ancestors[0];
    if (pid !== undefined) return pidAlive(pid);
    return !s || !s.lastSeen || Date.now() - s.lastSeen < QUIET_MS;
  };
  const open = (res?: http.ServerResponse) => !!res && !res.writableEnded && !res.destroyed;

  // Wake waiting chats whenever their checklist gains something unread.
  // Only read (which marks items as seen) when a connector is still there to receive the result.
  store.onChange(() => {
    for (const [sid, set] of [...waiters]) {
      // The user went away: stop the wait and tell Claude what to do instead.
      const list = store.forSession(sid);
      const away = !!list && store.isAway(list);
      if (!away && !store.hasUnread(sid)) continue;
      if (![...set].some((w) => open(w.res))) continue;
      waiters.delete(sid);
      const result = store.hasUnread(sid) ? store.handleTool(sid, {}, 'checklist_read', {}) : { content: [{ type: 'text' as const, text: store.awayNote(list)! }] };
      for (const resolve of set) resolve(result);
      changed();
    }
  });

  function wait(sessionId: string, minutes: number, res: http.ServerResponse): Promise<ToolResult> {
    // Handed to the Claude Code mod: say so, rather than that nothing is waiting.
    const locked = store.lockedFor(store.forSession(sessionId), sessionId);
    if (locked) return Promise.resolve({ content: [{ type: 'text', text: locked }] });
    if (store.hasUnread(sessionId)) return Promise.resolve(store.handleTool(sessionId, {}, 'checklist_read', {}));
    const away = store.awayNoteFor(sessionId);
    if (away) return Promise.resolve({ content: [{ type: 'text', text: away }] });
    if (!store.hasPending(sessionId))
      return Promise.resolve({
        content: [{ type: 'text', text: 'Nothing on this chat\'s checklist is waiting on the user, so there is nothing to wait for.' }],
      });
    const mins = Math.min(MAX_WAIT_MIN, Math.max(1, Number(minutes) || 20));
    return new Promise((resolve) => {
      let set = waiters.get(sessionId);
      if (!set) waiters.set(sessionId, (set = new Set()));
      const done: Waiter = (r: ToolResult) => {
        clearTimeout(timer);
        set!.delete(done);
        if (!set!.size) waiters.delete(sessionId);
        changed();
        resolve(r);
      };
      const timer = setTimeout(
        () =>
          done({
            content: [
              {
                type: 'text',
                text:
                  `No update after ${mins} minute${mins === 1 ? '' : 's'}: the user hasn't shared anything new yet. ` +
                  'Call checklist_wait again to keep waiting, or end your turn with a one-line note of what you are waiting for.',
              },
            ],
          }),
        mins * 60_000
      );
      // Claude stopped waiting (Esc, timeout on its side): stop showing "waiting".
      // (A request's own 'close' fires once its body is read, so watch the response instead.)
      res.on('close', () => {
        if (!res.writableEnded && set!.has(done)) {
          clearTimeout(timer);
          set!.delete(done);
          if (!set!.size) waiters.delete(sessionId);
          changed();
        }
      });
      done.res = res;
      set.add(done);
      changed();
    });
  }

  const server = http.createServer((req, res) => {
    const auth = Buffer.from(String(req.headers.authorization ?? ''));
    const authorised = auth.length === expected.length && timingSafeEqual(auth, expected);
    const route = req.url === '/call' || req.url === '/poll' ? req.url : '';
    if (!route || req.method !== 'POST' || req.headers.origin || !authorised) {
      res.writeHead(route ? 403 : 404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', async () => {
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof msg.sessionId !== 'string') {
        res.writeHead(400).end();
        return;
      }
      const s = session(msg.sessionId);
      s.lastSeen = Date.now();
      const key = () => JSON.stringify([s.ancestors, s.channel, s.polling]);
      const before = key();
      if (msg.process && Array.isArray(msg.process.ancestors)) {
        s.ancestors = msg.process.ancestors.filter((n: unknown) => Number.isInteger(n)).slice(0, 16);
        s.channel = msg.process.channel === true;
      }
      const send = (obj: object) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (route === '/poll') {
        // Long-poll for channel pushes. One poll per chat at a time.
        s.polling = true;
        if (before !== key()) changed();
        const q = queued.get(msg.sessionId);
        if (q?.length) {
          queued.delete(msg.sessionId);
          return send({ events: q });
        }
        polls.get(msg.sessionId)?.([]);
        const timer = setTimeout(() => finish([]), 25_000);
        const finish = (events: string[]) => {
          clearTimeout(timer);
          if (polls.get(msg.sessionId) === finish) polls.delete(msg.sessionId);
          send({ events });
        };
        polls.set(msg.sessionId, finish);
        res.on('close', () => {
          if (!res.writableEnded && polls.get(msg.sessionId) === finish) {
            polls.delete(msg.sessionId);
            clearTimeout(timer);
            // If the connector doesn't come back within a few seconds, channel delivery is gone.
            setTimeout(() => {
              if (!polls.has(msg.sessionId)) {
                s.polling = false;
                changed();
              }
            }, 5000);
          }
        });
        return;
      }

      if (typeof msg.tool !== 'string') {
        res.writeHead(400).end();
        return;
      }
      if (before !== key()) changed();
      if (msg.tool === '__hello') return send({ ok: true });
      s.lastCall = Date.now();
      log(`${msg.tool} from chat ${msg.sessionId.split('-')[0]} (${msg.cwd ?? '?'})`);
      const result =
        msg.tool === 'checklist_wait'
          ? await wait(msg.sessionId, msg.args?.timeout_minutes, res)
          : store.handleTool(msg.sessionId, { cwd: msg.cwd, client: msg.client }, msg.tool, msg.args ?? {});
      send(result);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  return {
    server,
    sessions,
    isWaiting: (id) => (waiters.get(id)?.size ?? 0) > 0,
    isAlive,
    prune() {
      let dropped = false;
      for (const id of [...sessions.keys()]) {
        if (isAlive(id)) continue;
        sessions.delete(id);
        queued.delete(id);
        polls.get(id)?.([]);
        polls.delete(id);
        dropped = true;
      }
      if (dropped) changed();
      return dropped;
    },
    push(sessionId, content) {
      const s = sessions.get(sessionId);
      if (!s?.channel) return false;
      const p = polls.get(sessionId);
      if (p) p([content]);
      else {
        if (!s.polling || !isAlive(sessionId)) return false;
        queued.set(sessionId, [...(queued.get(sessionId) ?? []), content].slice(-20));
      }
      return true;
    },
    endWaits(text) {
      for (const set of [...waiters.values()]) for (const done of [...set]) done({ content: [{ type: 'text', text }] });
    },
    onSessionsChange: (fn) => changeFns.push(fn),
  };
}
