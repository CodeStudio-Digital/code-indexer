import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('HTTP worker dev bootstrap', () => {
  it('keeps tsx scoped so an installed ESM .js bundle retains named exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-worker-bootstrap-'));
    tempDirs.push(dir);
    const entryDir = join(dir, 'entry');
    const pluginDir = join(dir, 'installed-plugin');
    mkdirSync(entryDir);
    mkdirSync(pluginDir);

    // Deliberately omit package.json. Installed plugin bundles historically
    // lived in this exact package-less shape outside the repository.
    writeFileSync(
      join(pluginDir, 'plugin.js'),
      [
        "export const providerAdapter = { sdkVersion: 2, kind: 'fixture' };",
        'export default { tools: [] };',
      ].join('\n'),
    );
    // The real worker entry belongs to the repository's ESM package scope.
    // Keep that scope separate from the package-less installed bundle.
    writeFileSync(join(entryDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(entryDir, 'entry.ts'),
      [
        "import { parentPort } from 'node:worker_threads';",
        "const plugin = await import('../installed-plugin/plugin.js');",
        'parentPort?.postMessage({',
        '  keys: Object.keys(plugin).sort(),',
        '  adapterKind: plugin.providerAdapter?.kind ?? null,',
        '});',
      ].join('\n'),
    );

    const bootstrap = resolve(process.cwd(), 'apps/http-api/workers/_dev-bootstrap.mjs');
    const worker = new Worker(bootstrap, { workerData: { tsEntry: join(entryDir, 'entry.ts') } });
    const result = await new Promise<{ keys: string[]; adapterKind: string | null }>((resolveMessage, reject) => {
      worker.once('message', resolveMessage);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      });
    });

    expect(result.keys).toEqual(expect.arrayContaining(['default', 'providerAdapter']));
    expect(result.adapterKind).toBe('fixture');
  });
});
