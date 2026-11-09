import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const outfile = resolve('.tmp/desktop-interactions/mcp-catalog-benchmark.cjs');
await build({ entryPoints: ['scripts/fixtures/desktop-interactions/mcp-catalog-benchmark.ts'],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [outfile], { env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', error => { console.error(error); process.exitCode = 1; });
