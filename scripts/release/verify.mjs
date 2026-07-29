/**
 * Verification stage: prove the artifact works before it can be published.
 *
 * Deliberately runs AFTER packaging and BEFORE publishing — electron-builder's
 * own `--publish` uploads during the build, which would put artifacts on GitHub
 * before anything had checked them.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkAsarClosure } from './asar-closure.mjs';

/** Entry points the packaged app actually boots from. */
const ENTRY_POINTS = ['dist/apps/electron/main.js', 'dist/apps/http-api/server.js'];

function electronBinary(root) {
  const require = createRequire(path.join(root, 'package.json'));
  // The `electron` package exports the absolute path to its binary.
  return require('electron');
}

/**
 * Runs the Electron-side probes. Electron writes GPU/Vulkan noise to stderr on
 * Windows, so the harness marks its payload and we parse only that line.
 */
export function runSmokeProbes(root, resourcesDir) {
  const binary = electronBinary(root);
  const harness = path.join(root, 'scripts/release/smoke.cjs');
  const result = spawnSync(binary, [harness, resourcesDir], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
  });
  const line = (result.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('SMOKE_RESULT:'));
  if (!line) {
    return {
      ok: false,
      error: 'smoke harness produced no result',
      detail: (result.stderr || result.stdout || '').split('\n').slice(-5).join('\n'),
    };
  }
  const report = JSON.parse(line.slice('SMOKE_RESULT:'.length));
  const ok =
    !report.harnessError &&
    report.renderer?.ok === true &&
    report.deepLink?.ok === true &&
    report.indexer?.ok === true;
  return { ok, report };
}

/** Full verification pass over a packaged build. */
export function verifyBuild(root, outputDir) {
  const resourcesDir = path.join(outputDir, 'win-unpacked', 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  if (!existsSync(asarPath)) {
    return { ok: false, checks: [{ name: 'artifact', ok: false, detail: `app.asar not found at ${asarPath}` }] };
  }

  const checks = [];

  const closure = checkAsarClosure(root, asarPath, ENTRY_POINTS);
  checks.push({
    name: 'module closure',
    ok: closure.ok,
    detail: closure.ok
      ? `${closure.scanned} modules reachable, ${closure.barePackages} packages, none missing`
      : [
          ...closure.unknownEntries.map((e) => `entry point not packaged: ${e}`),
          ...closure.missingFirstParty.map((m) => `missing file: ${m.spec} (from ${m.from})`),
          ...closure.missingPackages.map((m) => `missing package: ${m.name} (from ${m.importer})`),
        ].join('\n            '),
  });

  const smoke = runSmokeProbes(root, resourcesDir);
  if (smoke.error) {
    checks.push({ name: 'runtime probes', ok: false, detail: `${smoke.error}\n${smoke.detail ?? ''}` });
  } else {
    const r = smoke.report;
    checks.push({
      name: 'renderer paints',
      ok: r.renderer?.ok === true,
      detail: r.renderer?.ok
        ? `mounted (${r.renderer.children} nodes), location intact, relative assets load`
        : `mounted=${r.renderer?.mounted} locationIntact=${r.renderer?.locationIntact} assets=${r.renderer?.relativeAssetLoads} ${r.renderer?.error ?? ''}`,
    });
    checks.push({
      name: 'deep link',
      ok: r.deepLink?.ok === true,
      detail: `hash ${r.deepLink?.hash ?? '(none)'}`,
    });
    checks.push({
      name: 'indexer parses',
      ok: r.indexer?.ok === true,
      detail: r.indexer?.ok ? 'tree-sitter loads wasm from asar in a worker' : (r.indexer?.error ?? 'failed'),
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
