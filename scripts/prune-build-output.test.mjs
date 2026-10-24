import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pruneBuildOutput } from './prune-build-output.mjs';

test('removed runtime sources cannot leave executable compiler output in a new package', () => {
  const root = mkdtempSync(join(tmpdir(), 'codestudio-prune-build-'));
  const put = (file, value = '') => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), value); };
  try {
    put('packages/runtime/src/current.ts');
    put('dist/packages/runtime/src/current.js', 'current');
    put('dist/packages/runtime/src/removed.js', 'stale');
    put('dist/packages/runtime/src/removed.js.map');
    put('dist/packages/runtime/src/removed.d.ts');
    put('dist/packages/runtime/src/removed.d.ts.map');
    put('dist/apps/electron/preload.cjs', 'preload');
    put('dist/apps/electron/splash.html', 'splash');
    put('dist/apps/http-api/vendor/drawio/js/editor.js', 'copied vendor');
    put('dist/apps/http-api/node_modules/helper/index.js', 'copied dependency');
    put('apps/http-api/fixtures/copied.js', 'source asset');
    put('dist/apps/http-api/fixtures/copied.js', 'source asset');
    put('dist/electron-builder/release.js', 'previous release');
    assert.equal(pruneBuildOutput(root).length, 4);
    assert.equal(existsSync(join(root, 'dist/packages/runtime/src/removed.js')), false);
    for (const [file, expected] of [
      ['dist/packages/runtime/src/current.js', 'current'],
      ['dist/apps/electron/preload.cjs', 'preload'],
      ['dist/apps/electron/splash.html', 'splash'],
      ['dist/apps/http-api/vendor/drawio/js/editor.js', 'copied vendor'],
      ['dist/apps/http-api/node_modules/helper/index.js', 'copied dependency'],
      ['dist/apps/http-api/fixtures/copied.js', 'source asset'],
      ['dist/electron-builder/release.js', 'previous release'],
    ]) {
      assert.equal(readFileSync(join(root, file), 'utf8'), expected);
    }
    assert.deepEqual(pruneBuildOutput(root), []);
  } finally { rmSync(root, { recursive: true }); }
});
