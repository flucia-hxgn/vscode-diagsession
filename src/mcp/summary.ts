// A text-sized digest of a profile for an agent: what the Summary tab shows, without the webview.
// Node only: no `vscode` import.

import type { RawProfile } from '../../shared/protocol';

export interface FunctionSummary {
  function: string;
  module: string;
  selfMs: number;
  selfPercent: number;
  totalMs: number;
  totalPercent: number;
  /** Where the function is defined, when the symbols tell. */
  source?: string;
}

export interface ProfileSummary {
  process: { pid: number; name: string; commandLine: string };
  /** Other processes of the trace, busiest first: pass a pid to analyse one of them. */
  otherProcesses: { pid: number; name: string; samples: number }[];
  traceDurationMs: number;
  samples: number;
  cpuMs: number;
  logicalProcessors: number;
  /** Share of the samples whose leaf function has a name. */
  symbolCoveragePercent: number;
  /** From the root down, following the most expensive callee. */
  hotPath: { function: string; module: string; totalPercent: number; selfPercent: number }[];
  topBySelf: FunctionSummary[];
  topByTotal: FunctionSummary[];
  modules: { module: string; selfMs: number; selfPercent: number; symbols: boolean }[];
  threads: { tid: number; name: string; cpuMs: number; percent: number }[];
}

interface Node {
  func: number;
  self: number;
  total: number;
  children: Map<number, Node>;
}

const round = (n: number, digits = 1) => {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};

export function summarize(raw: RawProfile, top = 20): ProfileSummary {
  top = Math.max(1, Math.min(200, Math.floor(top) || 20));
  const sampleMs = raw.sampleIntervalMs || 1;
  const nFuncs = raw.funcNames.length;
  const nStacks = raw.stackParent.length;
  const stackFunc = new Int32Array(nStacks);
  for (let s = 0; s < nStacks; s++) stackFunc[s] = raw.addrFunc[raw.stackAddr[s]];

  // Samples per stack, and per thread.
  const stackCount = new Float64Array(nStacks);
  const threadCount = new Float64Array(raw.threads.length);
  let samples = 0;
  for (let i = 0; i < raw.sampleStack.length; i++) {
    const s = raw.sampleStack[i];
    samples++;
    const t = raw.sampleThread[i];
    if (t >= 0 && t < threadCount.length) threadCount[t]++;
    if (s >= 0 && s < nStacks) stackCount[s]++;
  }

  const self = new Float64Array(nFuncs);
  const total = new Float64Array(nFuncs);
  const seen = new Int32Array(nFuncs).fill(-1);
  const root: Node = { func: -1, self: 0, total: 0, children: new Map() };
  const chain: number[] = [];
  for (let s = 0; s < nStacks; s++) {
    const n = stackCount[s];
    if (!n) continue;
    self[stackFunc[s]] += n;
    chain.length = 0;
    for (let x = s; x >= 0; x = raw.stackParent[x]) {
      const f = stackFunc[x];
      chain.push(f);
      // A recursive function counts once per sample.
      if (seen[f] !== s) {
        seen[f] = s;
        total[f] += n;
      }
    }
    let node = root;
    node.total += n;
    for (let i = chain.length - 1; i >= 0; i--) {
      let child = node.children.get(chain[i]);
      if (!child) node.children.set(chain[i], (child = { func: chain[i], self: 0, total: 0, children: new Map() }));
      child.total += n;
      node = child;
    }
    node.self += n;
  }

  const pct = (n: number) => (samples ? round((100 * n) / samples) : 0);
  const moduleOf = (f: number) => raw.modules[raw.funcModule[f]]?.name ?? 'unknown';
  const nameOf = (f: number) => (raw.funcNames[f] === '?' ? `${moduleOf(f)} (no symbols)` : raw.funcNames[f]);

  // Where each function starts: its lowest known line.
  const funcSource = new Map<number, { file: number; line: number }>();
  for (let a = 0; a < raw.addrFunc.length; a++) {
    const f = raw.addrFunc[a];
    const file = raw.addrFile[a];
    if (file < 0 || !total[f]) continue;
    const line = raw.addrLine[a];
    const prev = funcSource.get(f);
    if (!prev || (line > 0 && line < prev.line)) funcSource.set(f, { file, line });
  }
  const sourceOf = (f: number) => {
    const s = funcSource.get(f);
    return s ? { source: `${raw.files[s.file]}:${s.line}` } : {};
  };

  const describe = (f: number): FunctionSummary => ({
    function: nameOf(f),
    module: moduleOf(f),
    selfMs: round(self[f] * sampleMs),
    selfPercent: pct(self[f]),
    totalMs: round(total[f] * sampleMs),
    totalPercent: pct(total[f]),
    ...sourceOf(f),
  });
  const funcs: number[] = [];
  for (let f = 0; f < nFuncs; f++) if (total[f]) funcs.push(f);
  const topBy = (key: Float64Array) =>
    funcs
      .filter((f) => key[f] > 0)
      .sort((a, b) => key[b] - key[a])
      .slice(0, top)
      .map(describe);

  const hotPath: ProfileSummary['hotPath'] = [];
  for (let node = root; hotPath.length < 64; ) {
    let best: Node | undefined;
    for (const c of node.children.values()) if (!best || c.total > best.total) best = c;
    // Stop where the time is spent in the function itself rather than in a callee.
    if (!best || (node !== root && node.self > best.total)) break;
    hotPath.push({ function: nameOf(best.func), module: moduleOf(best.func), totalPercent: pct(best.total), selfPercent: pct(best.self) });
    node = best;
  }

  const moduleSelf = new Float64Array(raw.modules.length);
  let named = 0;
  for (let f = 0; f < nFuncs; f++) {
    if (!self[f]) continue;
    if (raw.funcNames[f] !== '?') named += self[f];
    const m = raw.funcModule[f];
    if (m >= 0 && m < moduleSelf.length) moduleSelf[m] += self[f];
  }

  return {
    process: { pid: raw.process.pid, name: raw.process.name, commandLine: raw.process.commandLine },
    otherProcesses: raw.processes.filter((p) => p.pid !== raw.process.pid).slice(0, 10),
    traceDurationMs: round(raw.traceDurationMs),
    samples,
    cpuMs: round(samples * sampleMs),
    logicalProcessors: raw.cpuCount,
    symbolCoveragePercent: pct(named),
    hotPath,
    topBySelf: topBy(self),
    topByTotal: topBy(total),
    modules: raw.modules
      .map((m, i) => ({ module: m.name, selfMs: round(moduleSelf[i] * sampleMs), selfPercent: pct(moduleSelf[i]), symbols: m.symbols }))
      .filter((m) => m.selfMs > 0)
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, top),
    threads: raw.threads
      .map((t, i) => ({ tid: t.tid, name: t.name, cpuMs: round(threadCount[i] * sampleMs), percent: pct(threadCount[i]) }))
      .filter((t) => t.cpuMs > 0)
      .sort((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, top),
  };
}
