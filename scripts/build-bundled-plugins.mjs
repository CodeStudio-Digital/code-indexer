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
 * CodeStudio Local ships its provider integrations in the host.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchJsDebugWorkerHandoff, stageJsDebugAdapter } from './js-debug-adapter-artifact.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extensions');
const stageRoot = join(root, 'dist', 'bundled-plugins');
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function run(cmd, args) {
  console.log(`\n→ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    console.error(`\n✗ Step failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const plugins = ['angular', 'figma', 'javascript-debugger'];
const stampFile = join(stageRoot, '.source-sha256');

function addInputs(digest, files, directories) {
  function add(path) {
    const full = join(root, path);
    if (!existsSync(full)) return;
    const entries = readdirSync(full, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) add(child);
      else if (entry.isFile()) addFile(child);
    }
  }
  function addFile(path) {
    const full = join(root, path);
    if (existsSync(full)) digest.update(path).update('\0').update(readFileSync(full)).update('\0');
  }
  for (const file of files) addFile(file);
  for (const directory of directories) add(directory);
  return digest.digest('hex');
}

const sharedFingerprint = addInputs(createHash('sha256'),
  ['pnpm-lock.yaml', 'scripts/build-bundled-plugins.mjs', 'scripts/js-debug-adapter-artifact.mjs'],
  ['packages/plugin-sdk/src', 'packages/provider-sdk/src']);
const pluginFingerprints = Object.fromEntries(plugins.map(ns => {
  const base = `extensions/${ns}`;
  const files = [`${base}/plugin.json`, `${base}/THIRD_PARTY_NOTICES.md`];
  const directories = [`${base}/src`];
  if (ns === 'figma') {
    files.push(`${base}/ui/panel.template.html`);
    directories.push(`${base}/ui/src`);
  }
  return [ns, addInputs(createHash('sha256').update(sharedFingerprint), files, directories)];
}));
const fingerprint = createHash('sha256').update(JSON.stringify(pluginFingerprints)).digest('hex');
const requiredOutputs = [
  ...plugins.flatMap(ns => [`${ns}/plugin.json`, `${ns}/.app.json`, `${ns}/dist/plugin.js`]),
  'figma/ui/panel.html',
  'javascript-debugger/adapter/js-debug/src/dapDebugServer.js',
];
if (process.argv.includes('--if-changed') && existsSync(stampFile)
    && readFileSync(stampFile, 'utf8') === fingerprint
    && requiredOutputs.every(file => existsSync(join(stageRoot, file)))) {
  console.log('Bundled plugins are up to date.');
  process.exit(0);
}

if (existsSync(stageRoot)) {
  const expected = join(realpathSync(root), 'dist', 'bundled-plugins');
  if (realpathSync(stageRoot) !== expected) throw new Error('Bundled plugin output is outside its expected workspace directory.');
  rmSync(stageRoot, { recursive: true, force: true });
}
mkdirSync(stageRoot, { recursive: true });

for (const ns of plugins) {
  const srcDir = join(extDir, ns);
  // Build → emits dist/plugin.js + .app.json from the declarative spec.
  const buildArgs = [
    tsxCli,
    'packages/plugin-sdk/src/cli/index.ts',
    'build',
    `extensions/${ns}`,
  ];
  buildArgs.push('--trust-first-party');
  run(process.execPath, buildArgs);

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

  if (ns === 'figma') {
    mkdirSync(join(dest, 'ui'), { recursive: true });
    copyFileSync(join(srcDir, 'ui', 'panel.html'), join(dest, 'ui', 'panel.html'));
  }

  if (ns === 'javascript-debugger') {
    const adapterDest = join(dest, 'adapter');
    const adapterSource = await stageJsDebugAdapter(root, adapterDest);
    const installedAdapter = join(adapterDest, 'js-debug');
    cpSync(adapterSource, installedAdapter, { recursive: true });
    const adapterEntry = join(installedAdapter, 'src', 'dapDebugServer.js');
    writeFileSync(adapterEntry, patchJsDebugWorkerHandoff(readFileSync(adapterEntry, 'utf8')));
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
  const languageServerCount = Array.isArray(app.languageServers) ? app.languageServers.length : 0;
  if (count !== 0) {
    console.error(`✗ ${ns}: local product plugins cannot register providers`);
    process.exit(1);
  }
  if (ns === 'javascript-debugger' && debuggerCount === 0) {
    console.error(`✗ ${ns}: bundled debugger has no debugger declarations`);
    process.exit(1);
  }
  if (ns === 'angular' && languageServerCount === 0) {
    console.error(`✗ ${ns}: bundled Angular plugin has no language-server declarations`);
    process.exit(1);
  }
  console.log(`  staged ${ns} → ${dest} (${count} provider spec(s), ${debuggerCount} debugger(s), ${languageServerCount} language server(s))`);
  writeFileSync(join(dest, '.source-sha256'), pluginFingerprints[ns]);
}

writeFileSync(stampFile, fingerprint);
console.log(`\n✓ Staged ${plugins.length} bundled plugin(s) → ${stageRoot}`);
