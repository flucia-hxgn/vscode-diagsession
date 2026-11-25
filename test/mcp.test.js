// End to end without VS Code: the built MCP server (dist/mcp-server.js) against the bridge and the registry of
// two fake windows. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagsession-mcp-'));
process.env.DIAGSESSION_HOME = path.join(tmp, 'home');

/** The extension-side modules, bundled for Node (they do not import `vscode`). */
function load(entry) {
  const out = path.join(tmp, path.basename(entry, '.ts') + '.cjs');
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return require(out);
}
const { startBridge } = load('src/mcp/bridge.ts');
const registry = load('src/mcp/registry.ts');
const { summarize } = load('src/mcp/summary.ts');

/** A client of the MCP server over stdio. */
function client(env = {}, cwd = tmp) {
  const child = cp.spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buffer = '';
  let next = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let nl; (nl = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(nl + 1)) {
      const m = JSON.parse(buffer.slice(0, nl));
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    request,
    tool: async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result,
    close: () => child.kill(),
  };
}

async function fakeWindow(id, folder) {
  const calls = [];
  const bridge = await startBridge({
    open: async (file) => (calls.push(['open', file]), {}),
    captures: async () => [{ path: path.join(folder, 'a.diagsession') }],
    summary: async (file, options) => (calls.push(['summary', file, options]), { hotPath: [] }),
  });
  await registry.writeWindow({ id, pid: process.pid, port: bridge.port, token: bridge.token, folders: [folder], name: path.basename(folder) });
  return { calls, bridge };
}

test('MCP server', async (t) => {
  const projA = path.join(tmp, 'projA');
  const projB = path.join(tmp, 'projB');
  const elsewhere = path.join(tmp, 'elsewhere');
  for (const d of [projA, projB, elsewhere]) fs.mkdirSync(d, { recursive: true });
  const inA = path.join(projA, 'run.diagsession');
  const outside = path.join(elsewhere, 'run.diagsession');
  for (const f of [inA, outside]) fs.writeFileSync(f, '');

  const a = await fakeWindow('win-a', projA);
  const b = await fakeWindow('win-b', projB);
  const c = client();
  t.after(() => {
    c.close();
    a.bridge.close();
    b.bridge.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('handshake and tool list', async () => {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.version, require('../package.json').version);
    const { tools } = (await c.request('tools/list')).result;
    assert.deepEqual(tools.map((x) => x.name).sort(), ['get_profile_summary', 'list_captures', 'list_windows', 'open_diagsession']);
    assert.equal((await c.request('nope')).error.code, -32601);
  });

  await t.test('a capture inside a workspace opens in that window', async () => {
    const r = await c.tool('open_diagsession', { path: inA });
    assert.ok(!r.isError, r.content[0].text);
    assert.deepEqual(a.calls.pop(), ['open', inA]);
    assert.equal(b.calls.length, 0);
  });

  await t.test('"workspace" picks the window, also from a subfolder', async () => {
    const r = await c.tool('open_diagsession', { path: outside, workspace: path.join(projB, 'src') });
    assert.ok(!r.isError, r.content[0].text);
    assert.deepEqual(b.calls.pop(), ['open', outside]);
  });

  await t.test('never guesses between windows', async () => {
    const r = await c.tool('open_diagsession', { path: outside });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Several VS Code windows/);
    assert.ok(r.content[0].text.includes(projA) && r.content[0].text.includes(projB));
    const wrong = await c.tool('open_diagsession', { path: outside, workspace: elsewhere });
    assert.match(wrong.content[0].text, /No VS Code window has/);
  });

  await t.test('an agent in a window terminal, or working in its folder, comes back to it', async () => {
    const inTerminal = client({ DIAGSESSION_WINDOW: 'win-b' });
    const inFolder = client({}, projA);
    t.after(() => (inTerminal.close(), inFolder.close()));
    assert.ok(!(await inTerminal.tool('open_diagsession', { path: outside })).isError);
    assert.deepEqual(b.calls.pop(), ['open', outside]);
    assert.ok(!(await inFolder.tool('open_diagsession', { path: outside })).isError);
    assert.deepEqual(a.calls.pop(), ['open', outside]);
  });

  await t.test('bad input is refused before reaching VS Code', async () => {
    for (const args of [{}, { path: 'rel.diagsession' }, { path: path.join(projA, 'x.txt') }, { path: path.join(projA, 'missing.diagsession') }]) {
      assert.equal((await c.tool('open_diagsession', args)).isError, true);
    }
    assert.equal(a.calls.length + b.calls.length, 0);
  });

  await t.test('summary, captures and windows', async () => {
    const s = await c.tool('get_profile_summary', { path: inA, top: 5 });
    assert.deepEqual(JSON.parse(s.content[0].text), { hotPath: [] });
    const [, file, options] = a.calls.pop();
    assert.equal(file, inA);
    assert.equal(options.top, 5);
    const caps = JSON.parse((await c.tool('list_captures', { workspace: projB })).content[0].text);
    assert.equal(caps.captures[0].path, path.join(projB, 'a.diagsession'));
    const windows = JSON.parse((await c.tool('list_windows')).content[0].text);
    assert.deepEqual(windows.map((w) => w.folders[0]).sort(), [projA, projB]);
  });

  await t.test('the bridge needs the token and refuses browsers', async () => {
    const post = (headers) =>
      fetch(`http://127.0.0.1:${a.bridge.port}/rpc`, { method: 'POST', headers, body: JSON.stringify({ method: 'captures' }) }).then((r) => r.status);
    assert.equal(await post({}), 401);
    assert.equal(await post({ authorization: 'Bearer wrong' }), 401);
    assert.equal(await post({ authorization: `Bearer ${a.bridge.token}`, origin: 'http://evil.example' }), 401);
    assert.equal(await post({ authorization: `Bearer ${a.bridge.token}` }), 200);
  });

  await t.test('a window that died is dropped from the registry', async () => {
    const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
    await registry.writeWindow({ id: 'dead', pid: dead, port: 1, token: 'x', folders: [elsewhere], name: 'dead' });
    assert.ok(!registry.readWindows().some((w) => w.id === 'dead'));
    assert.ok(!fs.existsSync(path.join(registry.registryDir(), 'dead.json')));
  });
});

test('window choice on Windows paths', () => {
  const w = (id, ...folders) => ({ id, pid: 1, port: 1, token: '', folders, name: id });
  const windows = [w('a', 'C:\\src\\App'), w('b', 'C:\\src\\App\\tools'), w('c', 'D:\\other')];
  const pick = (hints) => registry.pickWindow(windows, hints, true).window?.id;
  assert.equal(pick({ file: 'c:\\SRC\\app\\out\\x.diagsession' }), 'a'); // case-insensitive
  assert.equal(pick({ file: 'C:\\src\\App\\tools\\x.diagsession' }), 'b'); // deepest folder wins
  assert.equal(pick({ file: 'C:\\src\\Application\\x.diagsession', preferredId: 'c' }), 'c'); // not a prefix match
  assert.equal(pick({ workspace: 'D:/other/' }), 'c');
  assert.equal(pick({ file: 'E:\\x.diagsession' }), undefined);
});

test('profile summary', () => {
  // main -> work -> (leaf | work -> leaf), plus an unnamed frame; 10 samples of 1 ms.
  const raw = {
    traceDurationMs: 100, sampleIntervalMs: 1, cpuCount: 8,
    process: { pid: 7, name: 'app.exe', commandLine: 'app.exe' },
    processes: [{ pid: 7, name: 'app.exe', samples: 10 }, { pid: 9, name: 'other.exe', samples: 3 }],
    modules: [{ name: 'app.exe', symbols: true }, { name: 'ntdll.dll', symbols: false }],
    funcNames: ['main', 'work', 'leaf', '?'], funcModule: [0, 0, 0, 1],
    files: ['C:\\src\\app.cpp'],
    addrFunc: [0, 1, 2, 3], addrFile: [0, 0, 0, -1], addrLine: [10, 20, 30, 0],
    //            0:main 1:work 2:leaf 3:work(rec) 4:leaf 5:?
    stackParent: [-1, 0, 1, 1, 3, 0], stackAddr: [0, 1, 2, 1, 2, 3],
    threads: [{ tid: 100, name: 'main' }, { tid: 200, name: '' }],
    sampleTime: [], sampleThread: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    sampleStack: [2, 2, 2, 2, 4, 4, 1, 0, 5, 5],
  };
  const s = summarize(raw, 3);
  assert.equal(s.samples, 10);
  assert.equal(s.symbolCoveragePercent, 80);
  assert.deepEqual(s.hotPath.map((h) => h.function), ['main', 'work', 'leaf']);
  assert.deepEqual(s.topBySelf[0], { function: 'leaf', module: 'app.exe', selfMs: 6, selfPercent: 60, totalMs: 6, totalPercent: 60, source: 'C:\\src\\app.cpp:30' });
  const work = s.topByTotal.find((f) => f.function === 'work');
  assert.equal(work.totalMs, 7); // recursion counted once per sample
  assert.equal(s.topByTotal[0].function, 'main');
  assert.equal(s.topByTotal[0].totalPercent, 100);
  assert.deepEqual(s.modules.map((m) => [m.module, m.selfMs]), [['app.exe', 8], ['ntdll.dll', 2]]);
  assert.deepEqual(s.threads.map((t) => [t.tid, t.cpuMs]), [[100, 8], [200, 2]]);
  assert.deepEqual(s.otherProcesses.map((p) => p.pid), [9]);
  assert.ok(s.topBySelf.some((f) => f.function === 'ntdll.dll (no symbols)'));
});
