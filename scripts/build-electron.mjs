#!/usr/bin/env node
/*
 * Build the Electron desktop binary.
 *
 * Pipeline:
 *   1. tsc + tsc-alias                  ->  dist/apps/electron/...js (ESM)
 *   2. vite build apps/dashboard        ->  dist/dashboard/...
 *   3. esbuild preload.ts (CJS)         ->  dist/apps/electron/preload.cjs
 *      (Wipes tsc's ESM preload.js. Electron's preload sandbox refuses
 *      ESM imports for contextBridge/ipcRenderer - see electron#36899.
 *      The .cjs extension overrides the root "type":"module" so Node
 *      loads it as CommonJS regardless of the package field.)
 *   4. electron-builder                 ->  dist/electron-builder/...{exe,dmg,AppImage}
 *
 * Steps 1+2 run sequentially (stdio readability). Step 3 MUST wait
 * for step 1 (wipes its preload.js). Step 4 waits for everything.
 *
 * Flags:
 *   --skip-tsc            Skip the typescript compile step (use when
 *                         caller already ran `pnpm build`).
 *   --skip-dashboard      Skip the vite dashboard build.
 *   --target=<targets>    Pass-through to electron-builder
 *                         (e.g. --target=nsis, --target=dir).
 *   --no-package          Stop after the asset prep - useful for CI smoke
 *                         tests that just want to verify tsc + esbuild
 *                         succeed without spinning up electron-builder.
 *
 * Exit codes mirror the failed step's exit code.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argv_get = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
};

const skipTsc = flag('--skip-tsc');
const skipDashboard = flag('--skip-dashboard');
const noPackage = flag('--no-package');
const target = argv_get('--target');

function run(cmd, args, opts = {}) {
  console.log(`\n→ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`\n✗ Step failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

async function buildPreload() {
  // Lazy-import esbuild because the script is also used in CI where
  // we may want to fail fast on missing devDeps with a clear message.
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    console.error('esbuild not installed - run `pnpm install` first.');
    process.exit(1);
  }
  // `.cjs` (NOT `.js`) because root package.json has "type": "module".
  // Electron's preload loader respects that; an ESM-parsed preload
  // silently fails to expose contextBridge. See apps/electron/dev.ts
  // for the full explanation. main.ts references `preload.cjs`.
  const outfile = resolve(root, 'dist/apps/electron/preload.cjs');
  mkdirSync(dirname(outfile), { recursive: true });
  // Wipe any prior artifact AND the legacy preload.js tsc emits so
  // electron-builder doesn't accidentally ship two preload files.
  if (existsSync(outfile)) rmSync(outfile);
  const legacy = resolve(root, 'dist/apps/electron/preload.js');
  if (existsSync(legacy)) rmSync(legacy);
  await esbuild.build({
    entryPoints: [resolve(root, 'apps/electron/preload.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: 'linked',
    logLevel: 'info',
  });
  console.log(`✓ preload bundled (CJS) → ${outfile}`);
}

console.log('Building MCP IDE Electron app…');
console.log(`  root: ${root}`);
console.log(`  flags: tsc=${!skipTsc} dashboard=${!skipDashboard} package=${!noPackage} target=${target ?? '<default>'}`);

// 1. TypeScript + path-alias rewrite
if (!skipTsc) {
  run('pnpm', ['tsc']);
  run('pnpm', ['exec', 'tsc-alias']);
  run('node', ['scripts/copy-prompts.mjs']);
}

// 2. Vite dashboard (parallel-safe with esbuild because separate outputs,
//    but we run after tsc to keep stdio readable).
if (!skipDashboard) {
  run('pnpm', ['exec', 'vite', 'build', 'apps/dashboard']);
}

// 3. CJS preload bundle (overwrites the ESM tsc output)
await buildPreload();

if (noPackage) {
  console.log('\n--no-package: skipping electron-builder. Done.');
  process.exit(0);
}

// 4. electron-builder
const builderArgs = ['exec', 'electron-builder', '--config', 'apps/electron/electron-builder.json'];
if (target) builderArgs.push('--' + target);
run('pnpm', builderArgs);

console.log('\n✓ Build complete. Artifacts in dist/electron-builder/');
