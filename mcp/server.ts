// The MCP server an agent (Claude Code, Claude Desktop) starts: stdio on the agent's side, and on the other the
// VS Code window that has the project open, found in the registry the extension keeps (src/mcp/registry.ts).
// Self-contained: it runs with VS Code's own Node (ELECTRON_RUN_AS_NODE), so no Node install is needed.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { BridgeRequest, WINDOW_ENV, WindowEntry, pickWindow, readWindows } from '../src/mcp/registry';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const WORKSPACE_ARG = {
  type: 'string',
  description:
    'Absolute path of the project folder the capture belongs to. Picks the VS Code window that has this folder open. ' +
    'Pass it whenever you know it: required when several VS Code windows are open.',
};

const TOOLS = [
  {
    name: 'open_diagsession',
    title: 'Open a profiler capture in VS Code',
    description:
      'Opens a .diagsession (Visual Studio CPU Usage capture) or .etl file as a profiler report in the VS Code window ' +
      'that has the project open, so the report can show the project sources, symbols and Just My Code rules. ' +
      'The file must be on this machine. Returns the window it was opened in.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .diagsession or .etl file.' },
        workspace: WORKSPACE_ARG,
      },
      required: ['path'],
    },
  },
  {
    name: 'get_profile_summary',
    title: 'Summarise a profiler capture',
    description:
      'Analyses a .diagsession or .etl file and returns the hot path, the top functions by self and by total CPU time, ' +
      'and the time per module and per thread, as JSON. Uses the symbol settings of the VS Code window that has the ' +
      'project open. The first analysis of a capture can take a minute or more; it is cached afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .diagsession or .etl file.' },
        workspace: WORKSPACE_ARG,
        top: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of functions, modules and threads to list (default 20).' },
        pid: { type: 'integer', description: 'Process to analyse. Default: the one the report shows (the profiled process, else the busiest).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_captures',
    title: 'List profiler captures',
    description: 'Lists the .diagsession files recorded by the profiler of a VS Code window, newest first.',
    inputSchema: { type: 'object', properties: { workspace: WORKSPACE_ARG } },
  },
  {
    name: 'list_windows',
    title: 'List VS Code windows',
    description: 'Lists the VS Code windows that can open a profiler report, with their workspace folders.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function call(window: WindowEntry, request: BridgeRequest, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: window.port,
        path: '/rpc',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${window.token}` },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const m = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result?: unknown; error?: string };
            if (res.statusCode === 200) resolve(m.result);
            else reject(new Error(m.error || `VS Code answered ${res.statusCode}`));
          } catch {
            reject(new Error(`VS Code answered ${res.statusCode} with an unreadable body`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('VS Code did not answer in time')));
    req.on('error', (e) => reject(new Error(`Cannot reach the VS Code window: ${e.message}`)));
    req.end(body);
  });
}

class ToolError extends Error {}

const optionalString = (args: Record<string, unknown>, key: string) => {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
  return v;
};
const optionalInt = (args: Record<string, unknown>, key: string) => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError(`"${key}" must be an integer`);
  return v;
};

function capturePath(args: Record<string, unknown>): string {
  const p = optionalString(args, 'path');
  if (!p) throw new ToolError('"path" is required');
  if (!path.isAbsolute(p)) throw new ToolError(`"path" must be absolute: ${p}`);
  if (!/\.(diagsession|etl)$/i.test(p)) throw new ToolError(`Not a .diagsession or .etl file: ${p}`);
  if (!fs.existsSync(p)) throw new ToolError(`File not found on this machine: ${p}`);
  return p;
}

function choose(args: Record<string, unknown>, file?: string): WindowEntry {
  const choice = pickWindow(readWindows(), {
    workspace: optionalString(args, 'workspace'),
    file,
    preferredId: process.env[WINDOW_ENV],
    cwd: process.cwd(),
  });
  if ('error' in choice) throw new ToolError(choice.error);
  return choice.window;
}

const windowLabel = (w: WindowEntry) => (w.folders.length ? w.folders.join(', ') : w.name || 'a window with no folder');

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'open_diagsession': {
      const file = capturePath(args);
      const window = choose(args, file);
      await call(window, { method: 'open', file }, 30_000);
      return `Opened ${file} in the VS Code window of ${windowLabel(window)}. The report analyses the capture when it opens, which can take a minute the first time.`;
    }
    case 'get_profile_summary': {
      const file = capturePath(args);
      const window = choose(args, file);
      const result = await call(window, { method: 'summary', file, top: optionalInt(args, 'top'), pid: optionalInt(args, 'pid') }, 15 * 60_000);
      return JSON.stringify(result, null, 1);
    }
    case 'list_captures': {
      const window = choose(args);
      return JSON.stringify({ window: windowLabel(window), captures: await call(window, { method: 'captures' }, 30_000) }, null, 1);
    }
    case 'list_windows':
      return JSON.stringify(
        readWindows().map((w) => ({ name: w.name, folders: w.folders, current: w.id === process.env[WINDOW_ENV] || undefined })),
        null,
        1,
      );
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: any;
}

const send = (m: object): void => {
  process.stdout.write(JSON.stringify(m) + '\n');
};

async function handle(m: Rpc): Promise<void> {
  // Notifications and the client's answers need no reply.
  if (m.id === undefined || m.id === null || typeof m.method !== 'string') return;
  const result = (r: unknown) => send({ jsonrpc: '2.0', id: m.id, result: r });
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'vscode-diagsession', title: 'DiagSession Profiler', version: process.env.DIAGSESSION_MCP_VERSION || '0.0.0' },
        instructions:
          'Opens and summarises Visual Studio profiler captures (.diagsession, .etl) through the DiagSession Profiler extension of VS Code. ' +
          'After producing a capture, call open_diagsession with its absolute path and the project folder as "workspace".',
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      try {
        const text = await runTool(String(m.params?.name), (m.params?.arguments ?? {}) as Record<string, unknown>);
        return result({ content: [{ type: 'text', text }] });
      } catch (e) {
        return result({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let m: Rpc;
    try {
      m = JSON.parse(line) as Rpc;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    void handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
