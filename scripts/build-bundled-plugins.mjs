#!/usr/bin/env node
/*
 * Build every bundled first-party plugin and stage its install artifacts into
 *   dist/bundled-plugins/<namespace>/   (plugin.json + .app.json [+ dist/])
 *
 * These are the FIRST-PARTY plugins that ship with the app and are
 * seeded into the installed-plugins store on first boot (see
 * apps/http-api/server seedBundledPlugins). The staged tree is shipped:
 *   - desktop: electron-builder `extraResources` → resourcesPath/bundled-plugins
 *   - cloud:   the same dist/bundled-plugins/ is included in the deploy bundle
 *
 * Discovers `extensions/provider-*` automatically and includes explicit
 * product plugins whose executable runtime is gated by bundled provenance.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageJsDebugAdapter } from './js-debug-adapter-artifact.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extensions');
const stageRoot = join(root, 'dist', 'bundled-plugins');

function run(cmd, args) {
  console.log(`\n→ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n✗ Step failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const bundledProductPlugins = new Set(['javascript-debugger']);
const plugins = readdirSync(extDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (d.name.startsWith('provider-') || bundledProductPlugins.has(d.name)))
  .map((d) => d.name)
  .sort();

if (plugins.length === 0) {
  console.error('No bundled plugin packages found.');
  process.exit(1);
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

for (const ns of plugins) {
  const srcDir = join(extDir, ns);
  // Build → emits dist/plugin.js + .app.json from the declarative spec.
  const buildArgs = [
    'tsx',
    'packages/plugin-sdk/src/cli/index.ts',
    'build',
    `extensions/${ns}`,
  ];
  if (ns.startsWith('provider-')) buildArgs.push('--trust-providers');
  run('npx', buildArgs);

  const appJson = join(srcDir, '.app.json');
  if (!existsSync(appJson)) {
    console.error(`✗ ${ns}: build produced no .app.json`);
    process.exit(1);
  }

  const dest = join(stageRoot, ns);
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(srcDir, 'plugin.json'), join(dest, 'plugin.json'));
  copyFileSync(appJson, join(dest, '.app.json'));
  const thirdPartyNotices = join(srcDir, 'THIRD_PARTY_NOTICES.md');
  if (existsSync(thirdPartyNotices)) copyFileSync(thirdPartyNotices, join(dest, 'THIRD_PARTY_NOTICES.md'));
  const distDir = join(srcDir, 'dist');
  if (existsSync(distDir)) cpSync(distDir, join(dest, 'dist'), { recursive: true });

  if (ns === 'javascript-debugger') {
    const adapterDest = join(dest, 'adapter');
    const adapterSource = await stageJsDebugAdapter(root, adapterDest);
    const installedAdapter = join(adapterDest, 'js-debug');
    cpSync(adapterSource, installedAdapter, { recursive: true });
    // The standalone bundle uses CommonJS-style dynamic require. Without an
    // explicit package scope it inherits this repo's root `type: module` and
    // exits before opening the DAP port.
    writeFileSync(
      join(installedAdapter, 'package.json'),
      `${JSON.stringify({ type: 'commonjs', version: '1.117.0', private: true }, null, 2)}\n`,
    );
  }

  // Sanity: each bundled plugin must carry its expected declarative surface.
  const app = JSON.parse(readFileSync(join(dest, '.app.json'), 'utf8'));
  const count = Array.isArray(app.providers) ? app.providers.length : 0;
  const debuggerCount = Array.isArray(app.debuggers) ? app.debuggers.length : 0;
  if (ns.startsWith('provider-') && count === 0) {
    console.error(`✗ ${ns}: bundled provider has no provider specs`);
    process.exit(1);
  }
  if (ns === 'javascript-debugger' && debuggerCount === 0) {
    console.error(`✗ ${ns}: bundled debugger has no debugger declarations`);
    process.exit(1);
  }
  console.log(`  staged ${ns} → ${dest} (${count} provider spec(s), ${debuggerCount} debugger(s))`);
}

console.log(`\n✓ Staged ${plugins.length} bundled plugin(s) → ${stageRoot}`);
