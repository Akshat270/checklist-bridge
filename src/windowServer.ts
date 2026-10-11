// Local HTTP endpoint inside each VS Code window. The per-chat connector posts tool calls here.
import * as http from 'http';
import { timingSafeEqual } from 'crypto';
import { ChecklistStore } from './model';

export function createWindowServer(store: ChecklistStore, token: string, log: (s: string) => void = () => {}) {
  const expected = Buffer.from(`Bearer ${token}`);
  return http.createServer((req, res) => {
    const auth = Buffer.from(String(req.headers.authorization ?? ''));
    const authorised = auth.length === expected.length && timingSafeEqual(auth, expected);
    if (req.url !== '/call' || req.method !== 'POST' || req.headers.origin || !authorised) {
      res.writeHead(req.url === '/call' ? 403 : 404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof msg.sessionId !== 'string' || typeof msg.tool !== 'string') {
        res.writeHead(400).end();
        return;
      }
      log(`${msg.tool} from chat ${msg.sessionId.split('-')[0]} (${msg.cwd ?? '?'})`);
      const result = store.handleTool(msg.sessionId, { cwd: msg.cwd, client: msg.client }, msg.tool, msg.args ?? {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
}
