// The endpoint of a VS Code window the MCP server talks to: HTTP on the loopback interface, behind a token.
// Node only: no `vscode` import, the window's side comes in as handlers.

import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { BridgeRequest } from './registry';

export interface BridgeHandlers {
  open(file: string): Promise<unknown>;
  captures(): Promise<unknown>;
  summary(file: string, options: { top?: number; pid?: number }): Promise<unknown>;
}

export interface Bridge {
  port: number;
  token: string;
  close(): void;
}

const MAX_BODY = 64 * 1024;

export async function startBridge(handlers: BridgeHandlers): Promise<Bridge> {
  const token = crypto.randomBytes(24).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);

  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // A web page can reach the loopback interface: it sends an Origin and has no token.
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.origin || auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) {
      return reply(401, { error: 'unauthorized' });
    }
    if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: 'not found' });

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      try {
        const m = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeRequest;
        const needFile = () => {
          const file = (m as { file?: unknown }).file;
          if (typeof file !== 'string' || !file) throw new Error('"file" is required');
          return file;
        };
        let result: unknown;
        switch (m.method) {
          case 'open':
            result = await handlers.open(needFile());
            break;
          case 'captures':
            result = await handlers.captures();
            break;
          case 'summary':
            result = await handlers.summary(needFile(), { top: m.top, pid: m.pid });
            break;
          default:
            return reply(400, { error: `unknown method ${String((m as { method?: unknown }).method)}` });
        }
        reply(200, { result });
      } catch (e) {
        reply(500, { error: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    token,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
