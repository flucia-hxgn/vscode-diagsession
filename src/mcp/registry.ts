// What the MCP server (mcp/server.ts, a process started by the agent) and the extension host share:
// the registry of the VS Code windows that can open a report, and the choice of one of them.
// Node only: no `vscode` import.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A VS Code window running the extension, as written in the registry. */
export interface WindowEntry {
  /** Stable for a workspace: also the value of DIAGSESSION_WINDOW in the window's terminals. */
  id: string;
  /** The extension host process: the entry is stale once it is gone. */
  pid: number;
  port: number;
  /** Sent as a bearer token with every request. */
  token: string;
  /** Paths of the workspace folders. */
  folders: string[];
  /** Workspace name, for messages. */
  name: string;
}

/** Name of the variable set in the integrated terminals of a window, holding its {@link WindowEntry.id}. */
export const WINDOW_ENV = 'DIAGSESSION_WINDOW';

export type BridgeRequest =
  | { method: 'open'; file: string }
  | { method: 'captures' }
  | { method: 'summary'; file: string; top?: number; pid?: number };

/** Home of the registry and of the copy of the server the agents are pointed at. */
export function bridgeHome(): string {
  return process.env.DIAGSESSION_HOME || path.join(os.homedir(), '.vscode-diagsession');
}

export function registryDir(): string {
  return path.join(bridgeHome(), 'windows');
}

/** Path of the MCP server script, stable across extension updates. */
export function serverScript(): string {
  return path.join(bridgeHome(), 'mcp-server.js');
}

export async function writeWindow(entry: WindowEntry): Promise<void> {
  await fs.promises.mkdir(registryDir(), { recursive: true });
  const file = path.join(registryDir(), entry.id + '.json');
  // Written whole then renamed, so a reader never sees half an entry. Private: it holds the token.
  await fs.promises.writeFile(file + '.tmp', JSON.stringify(entry, null, 2), { mode: 0o600 });
  await fs.promises.rename(file + '.tmp', file);
}

/** Removes the entry of a window, unless another extension host took the id over since. */
export function removeWindow(id: string, pid: number): void {
  const file = path.join(registryDir(), id + '.json');
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as WindowEntry).pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, it is just not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The windows that are still running. Entries left by a crashed window are deleted. */
export function readWindows(): WindowEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return [];
  }
  const windows: WindowEntry[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(registryDir(), n);
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowEntry;
      if (typeof e.pid !== 'number' || typeof e.port !== 'number' || !Array.isArray(e.folders)) continue;
      if (alive(e.pid)) windows.push(e);
      else fs.rmSync(file, { force: true });
    } catch {
      // being written, or not ours
    }
  }
  return windows;
}

const norm = (p: string, win32: boolean) => {
  const r = (win32 ? path.win32 : path.posix).resolve(p).replace(/[\\/]+$/, '');
  return win32 ? r.toLowerCase() : r;
};

/** Length of `folder` when `p` is it or is inside it, else -1. */
function depthIn(folder: string, p: string, win32: boolean): number {
  const f = norm(folder, win32);
  const x = norm(p, win32);
  return x === f || x.startsWith(f + (win32 ? '\\' : '/')) ? f.length : -1;
}

export interface WindowHints {
  /** Project folder named by the agent. */
  workspace?: string;
  /** The capture to open. */
  file?: string;
  /** DIAGSESSION_WINDOW of the server's environment: set when the agent runs in a window's terminal. */
  preferredId?: string;
  /** Working directory of the server. */
  cwd?: string;
}

export type WindowChoice = { window: WindowEntry; reason: string } | { error: string };

const describe = (w: WindowEntry) => (w.folders.length ? w.folders.join(', ') : `${w.name || 'empty window'} (no folder)`);

/**
 * The window a report belongs in: the one that has the project open, so that the sources, the symbol paths and the
 * Just My Code rules are the project's. Never guesses between several windows: the error then lists them.
 */
export function pickWindow(windows: WindowEntry[], hints: WindowHints, win32 = process.platform === 'win32'): WindowChoice {
  if (!windows.length) {
    return {
      error:
        'No VS Code window with the DiagSession Profiler extension is running. Open the project folder in VS Code, then retry.',
    };
  }
  const list = windows.map((w) => `  - ${describe(w)}`).join('\n');

  /** The window with the deepest folder holding `p` (or, with `orInside`, a folder inside `p`). */
  const holding = (p: string, orInside = false): WindowEntry | undefined => {
    let best: WindowEntry | undefined;
    let bestDepth = -1;
    for (const w of windows) {
      for (const f of w.folders) {
        let d = depthIn(f, p, win32);
        if (d < 0 && orInside && depthIn(p, f, win32) >= 0) d = 0;
        if (d > bestDepth) {
          bestDepth = d;
          best = w;
        }
      }
    }
    return best;
  };

  if (hints.workspace) {
    const w = holding(hints.workspace, true);
    if (w) return { window: w, reason: 'workspace' };
    return { error: `No VS Code window has ${hints.workspace} open. Open it in VS Code, or pass one of these as "workspace":\n${list}` };
  }
  if (hints.file) {
    const w = holding(hints.file);
    if (w) return { window: w, reason: 'the capture is in its workspace' };
  }
  if (hints.preferredId) {
    const w = windows.find((x) => x.id === hints.preferredId);
    if (w) return { window: w, reason: 'the agent runs in its terminal' };
  }
  if (hints.cwd) {
    const w = holding(hints.cwd);
    if (w) return { window: w, reason: 'the agent works in its workspace' };
  }
  if (windows.length === 1) return { window: windows[0], reason: 'the only window' };
  return {
    error: `Several VS Code windows are open and nothing tells which one holds the project. Pass the project folder as "workspace". Open windows:\n${list}`,
  };
}
