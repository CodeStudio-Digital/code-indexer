import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const repo = resolve('.'), scratch = join(repo, 'scratch', 'harness-20261003');
const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) {
    if (!resolve(path).startsWith(scratch + sep)) throw new Error('Unsafe scanner fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function fixture() {
  await mkdir(scratch, { recursive: true });
  const path = await mkdtemp(join(scratch, 'boundary-scanner-')); owned.push(path);
  await mkdir(join(path, 'scripts')); await mkdir(join(path, 'apps'));
  await writeFile(join(path, 'scripts', 'rust-agent-legacy-boundary-baseline.json'), '[]');
  return path;
}
function scan(cwd: string) {
  return spawnSync(process.execPath, [join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(repo, 'scripts', 'check-rust-agent-legacy-boundary.ts')], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

it('ignores only repository edge inventories, without treating metadata paths as imports', async () => {
  const path = await fixture();
  for (const name of ['repository-boundaries.json', 'repository-boundaries-baseline.json']) {
    await writeFile(join(path, 'scripts', name), JSON.stringify(['@mcp/code-agent/core/runner.js', 'packages/code-agent/src/core/runner.ts']));
  }
  const result = scan(path);
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('0 active reference(s)');
});

it('still rejects executable legacy imports beside those inventories', async () => {
  const path = await fixture();
  await writeFile(join(path, 'apps', 'new-consumer.ts'), "import { CoderRunner } from '@mcp/code-agent/core/runner.js';\n");
  const result = scan(path);
  expect(result.status).toBe(1); expect(result.stderr).toContain('apps/new-consumer.ts::import::@mcp/code-agent/core/runner.js::CoderRunner');
});

it('still rejects legacy references in real manifests and ordinary JSON assets', async () => {
  const path = await fixture();
  await writeFile(join(path, 'package.json'), JSON.stringify({ dependencies: { '@mcp/code-agent': 'workspace:*' } }));
  await writeFile(join(path, 'apps', 'asset.json'), JSON.stringify({ path: 'packages/code-agent/src/private.json' }));
  const result = scan(path);
  expect(result.status).toBe(1); expect(result.stderr).toContain('package.json::literal::@mcp/code-agent::');
  expect(result.stderr).toContain('apps/asset.json::literal::packages/code-agent/src/private.json::');
});
