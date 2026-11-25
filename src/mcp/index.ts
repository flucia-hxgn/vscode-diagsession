import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { RawProfile } from '../../shared/protocol';
import { WINDOW_ENV, removeWindow, serverScript, writeWindow } from './registry';
import { analyze } from '../analyzer';
import { analysisRequest } from '../profileEditor';
import type { CapturesProvider } from '../profiler/capturesView';
import { startBridge } from './bridge';
import { summarize } from './summary';

const WINDOW_ID_KEY = 'mcp.windowId';
const SERVER_NAME = 'diagsession';

export interface McpDeps {
  openReport(file: string): Thenable<unknown>;
  captures: CapturesProvider;
}

/**
 * Makes this window reachable by the MCP server (mcp/server.ts): a loopback endpoint, an entry in the registry, and
 * DIAGSESSION_WINDOW in the window's terminals so that an agent started there comes back to this window.
 */
export async function startMcp(context: vscode.ExtensionContext, deps: McpDeps): Promise<vscode.Disposable> {
  // Stable for the workspace: the terminals outlive a window reload, and keep the value they were started with.
  let id = context.workspaceState.get<string>(WINDOW_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    await context.workspaceState.update(WINDOW_ID_KEY, id);
  }

  const bridge = await startBridge({
    async open(file) {
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      await deps.openReport(file);
      return {};
    },
    async captures() {
      const items = await deps.captures.getChildren();
      return Promise.all(
        items.map(async (c) => ({
          path: c.file,
          modified: new Date(c.mtime).toISOString(),
          sizeBytes: (await fs.promises.stat(c.file).catch(() => undefined))?.size,
        })),
      );
    },
    async summary(file, { top, pid }) {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Analysing ${path.basename(file)}`, cancellable: false },
        async (progress) => {
          const request = analysisRequest(context, file);
          if (pid !== undefined) request.pid = pid;
          const cts = new vscode.CancellationTokenSource();
          try {
            const { json } = await analyze(context, request, (text) => progress.report({ message: text }), cts.token);
            return summarize(JSON.parse(json) as RawProfile, top);
          } finally {
            cts.dispose();
          }
        },
      );
    },
  });

  const register = () =>
    writeWindow({
      id,
      pid: process.pid,
      port: bridge.port,
      token: bridge.token,
      folders: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
      name: vscode.workspace.name ?? '',
    });
  await register();
  await deployServer(context);

  context.environmentVariableCollection.description = 'Tells the DiagSession MCP server which VS Code window an agent runs in.';
  context.environmentVariableCollection.replace(WINDOW_ENV, id);

  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => void register());
  return new vscode.Disposable(() => {
    folders.dispose();
    bridge.close();
    removeWindow(id, process.pid);
  });
}

/** Copies the server where the agents' configurations point: a path that an extension update does not change. */
async function deployServer(context: vscode.ExtensionContext): Promise<void> {
  const source = await fs.promises.readFile(path.join(context.extensionPath, 'dist', 'mcp-server.js'));
  const target = serverScript();
  const current = await fs.promises.readFile(target).catch(() => undefined);
  if (current?.equals(source)) return;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target + '.tmp', source);
  await fs.promises.rename(target + '.tmp', target);
}

/** How an agent starts the server: with VS Code's own Node, so that none has to be installed. */
function serverCommand(): { command: string; args: string[]; env: Record<string, string> } {
  return { command: process.execPath, args: [serverScript()], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function claudeDesktopConfig(): string {
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Claude');
  return path.join(dir, 'claude_desktop_config.json');
}

const quote = (s: string) => `"${s}"`;

/** The "Set Up MCP Server for Claude" command. */
export async function setupMcp(): Promise<void> {
  const server = serverCommand();
  const pick = await vscode.window.showQuickPick(
    [
      { id: 'code', label: 'Claude Code', detail: 'Copies the "claude mcp add" command that registers the server for your user.' },
      { id: 'desktop', label: 'Claude Desktop', detail: `Adds the server to ${claudeDesktopConfig()}` },
      { id: 'json', label: 'Copy the JSON configuration', detail: 'For any other MCP client.' },
    ],
    { title: 'Set up the DiagSession MCP server', placeHolder: 'Which agent should open captures in VS Code?' },
  );
  if (!pick) return;

  if (pick.id === 'code') {
    // The name comes before --env: the option takes several values and would swallow it.
    const command = `claude mcp add --scope user ${SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${[server.command, ...server.args].map(quote).join(' ')}`;
    await vscode.env.clipboard.writeText(command);
    const run = await vscode.window.showInformationMessage('Copied the "claude mcp add" command. Run it once in a terminal.', 'Run in Terminal');
    if (run) {
      const terminal = vscode.window.createTerminal('DiagSession MCP');
      terminal.show();
      // Left for the user to confirm with Enter.
      terminal.sendText(command, false);
    }
    return;
  }

  if (pick.id === 'json') {
    await vscode.env.clipboard.writeText(JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2));
    vscode.window.showInformationMessage('Copied the MCP server configuration.');
    return;
  }

  const file = claudeDesktopConfig();
  let config: Record<string, any> = {};
  const text = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
  if (text?.trim()) {
    try {
      config = JSON.parse(text);
    } catch {
      // Never overwrite a file we could not read.
      throw new Error(`${file} is not valid JSON. Fix it, or use "Copy the JSON configuration".`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file} does not hold a JSON object.`);
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: server };
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  vscode.window.showInformationMessage('Added the DiagSession MCP server to Claude Desktop. Quit and restart Claude Desktop to load it.');
}
