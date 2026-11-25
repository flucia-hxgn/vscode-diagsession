import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const watch = process.argv.includes('--watch');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    target: 'node18',
    // jsonc-parser's UMD "main" hides its requires from esbuild
    mainFields: ['module', 'main'],
  },
  {
    // The MCP server the agents start, with VS Code's own Node.
    entryPoints: ['mcp/server.ts'],
    outfile: 'dist/mcp-server.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: false,
    define: { 'process.env.DIAGSESSION_MCP_VERSION': JSON.stringify(version) },
  },
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
  {
    entryPoints: ['webview/profiler.ts'],
    outfile: 'dist/profiler.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
];

for (const b of builds) {
  const options = { bundle: true, sourcemap: true, minify: !watch, logLevel: 'info', ...b };
  if (watch) {
    await (await esbuild.context(options)).watch();
  } else {
    await esbuild.build(options);
  }
}
