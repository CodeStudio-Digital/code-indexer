#!/usr/bin/env node
/*
 * Build every bundled provider plugin and stage its install artifacts into
 *   dist/bundled-plugins/<namespace>/   (plugin.json + .app.json [+ dist/])
 *
 * These are the FIRST-PARTY provider plugins that ship with the app and are
 * seeded into the installed-plugins store on first boot (see
 * apps/http-api/server seedBundledPlugins). The staged tree is shipped:
 *   - desktop: electron-builder `extraResources` → resourcesPath/bundled-plugins
 *   - cloud:   the same dist/bundled-plugins/ is included in the deploy bundle
 *
 * Discovers `extensions/provider-*` automatically, so a new connector package
 * is picked up with no edit here. Each is built via the plugin CLI (esbuild →
 * .app.json verbatim from the declarative ProviderSpec).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const providers = readdirSync(extDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('provider-'))
  .map((d) => d.name)
  .sort();

if (providers.length === 0) {
  console.error('No extensions/provider-* packages found.');
  process.exit(1);
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

for (const ns of providers) {
  const srcDir = join(extDir, ns);
  // Build → emits dist/plugin.js + .app.json from the declarative spec.
  run('npx', ['tsx', 'packages/plugin-sdk/src/cli/index.ts', 'build', `extensions/${ns}`]);

  const appJson = join(srcDir, '.app.json');
  if (!existsSync(appJson)) {
    console.error(`✗ ${ns}: build produced no .app.json`);
    process.exit(1);
  }

  const dest = join(stageRoot, ns);
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(srcDir, 'plugin.json'), join(dest, 'plugin.json'));
  copyFileSync(appJson, join(dest, '.app.json'));
  const distDir = join(srcDir, 'dist');
  if (existsSync(distDir)) cpSync(distDir, join(dest, 'dist'), { recursive: true });

  // Sanity: the staged manifest must carry at least one provider spec.
  const app = JSON.parse(readFileSync(join(dest, '.app.json'), 'utf8'));
  const count = Array.isArray(app.providers) ? app.providers.length : 0;
  console.log(`  staged ${ns} → ${dest} (${count} provider spec${count === 1 ? '' : 's'})`);
}

console.log(`\n✓ Staged ${providers.length} bundled provider plugin(s) → ${stageRoot}`);
