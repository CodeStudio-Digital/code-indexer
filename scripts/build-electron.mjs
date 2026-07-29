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
 *   --require-signing     Fail when a platform signing identity is missing.
 *   --no-package          Stop after the asset prep - useful for CI smoke
 *                         tests that just want to verify tsc + esbuild
 *                         succeed without spinning up electron-builder.
 *
 * Exit codes mirror the failed step's exit code.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync } from 'node:fs';
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
const requireSigning = flag('--require-signing');
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
    target: 'node22', // Electron 42 ships Node 24; node22 is the safe esbuild target.
    external: ['electron'],
    sourcemap: false,
    minify: true,
    logLevel: 'info',
  });
  console.log(`✓ preload bundled (CJS) → ${outfile}`);
}

console.log('Building CodeStudio Electron app…');
console.log(`  root: ${root}`);
console.log(
  `  flags: tsc=${!skipTsc} dashboard=${!skipDashboard}`
  + ` package=${!noPackage} target=${target ?? '<default>'}`
  + ` signing=${requireSigning ? 'required' : 'development'}`,
);

// 1. TypeScript + path-alias rewrite
if (!skipTsc) {
  // Production config: sourceMap/declaration/declarationMap OFF so no
  // .js.map / .d.ts(.map) ever ships in the ASAR. (Dev `pnpm build` keeps
  // maps via tsconfig.json.) tsc-alias rewrites the same dist with the prod
  // config's paths.
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.prod.json']);
  run('pnpm', ['exec', 'tsc-alias', '-p', 'tsconfig.prod.json']);
  run('node', ['scripts/copy-prompts.mjs']);
}

// 2. Vite dashboard (parallel-safe with esbuild because separate outputs,
//    but we run after tsc to keep stdio readable).
if (!skipDashboard) {
  run('pnpm', ['exec', 'vite', 'build', 'apps/dashboard']);
}

// 3. CJS preload bundle (overwrites the ESM tsc output)
await buildPreload();

// 3b. Copy the static splash page next to main so it ships in the asar
//     (tsc only emits .js — it never copies .html). main.ts/splash-window.ts
//     load it from dist/apps/electron/splash.html in the packaged app.
{
  const splashSrc = resolve(root, 'apps/electron/splash.html');
  const splashDest = resolve(root, 'dist/apps/electron/splash.html');
  if (existsSync(splashSrc)) {
    mkdirSync(dirname(splashDest), { recursive: true });
    copyFileSync(splashSrc, splashDest);
    console.log(`✓ splash copied → ${splashDest}`);
  } else {
    console.warn(`! splash.html not found at ${splashSrc} — splash will be skipped`);
  }
}

// 3c. Copy brand SVGs used by the static splash. These live beside
// splash.html in both dev and packaged builds, so the same relative paths work.
{
  const brandSrc = resolve(root, 'apps/electron/brand');
  const brandDest = resolve(root, 'dist/apps/electron/brand');
  if (existsSync(brandSrc)) {
    cpSync(brandSrc, brandDest, { recursive: true });
    console.log(`✓ splash brand assets copied → ${brandDest}`);
  } else {
    console.warn(`! brand assets not found at ${brandSrc} — splash logo will be skipped`);
  }
}

// 3d. Bundled provider plugins → dist/bundled-plugins/ (electron-builder ships
//     it via extraResources → resourcesPath/bundled-plugins; seeded on first boot).
run('node', ['scripts/build-bundled-plugins.mjs']);
run('node', ['scripts/package-rust-agent-runtime.mjs']);

if (noPackage) {
  console.log('\n--no-package: skipping electron-builder. Done.');
  process.exit(0);
}

// 3e. Rebuild native modules against Electron's ABI before packaging.
//     electron-builder's own npmRebuild is disabled (electron-builder.json)
//     because it would force a from-source node-pty build that fails on winpty
//     under pnpm/Windows. node-pty ships N-API prebuilds (ABI-stable) and needs
//     no rebuild; better-sqlite3 uses the V8 C++ API and MUST be rebuilt for
//     Electron — that's exactly what `electron:rebuild` (-o better-sqlite3) does.
run('pnpm', ['run', 'electron:rebuild']);

// 4. electron-builder
const builderArgs = ['exec', 'electron-builder', '--config', 'apps/electron/electron-builder.json'];
if (target) builderArgs.push('--' + target);
if (requireSigning) builderArgs.push('--config.forceCodeSigning=true');
run('pnpm', builderArgs);

console.log('\n✓ Build complete. Artifacts in dist/electron-builder/');
