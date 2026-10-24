import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceRuntimeCohortStore, WorkspaceRuntimeScope } from '../workspace-runtime-cohort.js';
import { ToolRegistry } from '../../core/registry.js';
import type { CoderTool } from '../../core/tool.js';

let root: string;
let project: string;
let directory: string;
beforeEach(async () => {
  vi.stubEnv('CODESTUDIO_RUNTIME_COHORT_GUARD', '1');
  root = await mkdtemp(join(tmpdir(), 'runtime-cohort-'));
  vi.stubEnv('MCP_RUNTIME_COORDINATION_DIR', join(root, 'shared'));
  project = join(root, 'project'); directory = join(root, 'runtime-workspace-cohorts');
  await mkdir(project);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const store = () => new WorkspaceRuntimeCohortStore(directory);
const tool = (overrides: Partial<CoderTool> = {}): CoderTool => ({ name: 'fixture', source: 'native', description: '',
  parameters: { type: 'object', properties: {} }, mutates: false, parallelSafe: true, riskLevel: 'read',
  handler: async () => ({ content: 'ok', isError: false }), ...overrides });

it('keeps rollout opt-in, then requires later legacy processes to respect the profile authority', async () => {
  vi.stubEnv('CODESTUDIO_NATIVE_CODER_DEV', '0'); vi.stubEnv('CODESTUDIO_RUNTIME_COHORT_GUARD', '0');
  const disabled = new WorkspaceRuntimeScope('legacy_ts');
  await disabled.enter(join(root, 'index.db'), 'legacy', [project]); await disabled.close(true);
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(new WorkspaceRuntimeScope('rust_v1').enter(join(root, 'index.db'), 'native', [project])).rejects.toThrow('enabled');
  vi.stubEnv('CODESTUDIO_RUNTIME_COHORT_GUARD', '1');
  const native = new WorkspaceRuntimeScope('rust_v1'); await native.enter(join(root, 'index.db'), 'native', [project]);
  vi.stubEnv('CODESTUDIO_RUNTIME_COHORT_GUARD', '0');
  await expect(new WorkspaceRuntimeScope('legacy_ts').enter(join(root, 'index.db'), 'legacy', [project])).rejects.toThrow('another runtime');
  await native.close(true);
});

it('fences overlapping workspaces across profiles even when the second profile has disabled the rollout flag', async () => {
  const native = new WorkspaceRuntimeScope('rust_v1');
  await native.enter(join(root, 'profile-a', 'index.db'), 'native', [project]);
  vi.stubEnv('CODESTUDIO_NATIVE_CODER_DEV', '0'); vi.stubEnv('CODESTUDIO_RUNTIME_COHORT_GUARD', '0');
  const legacy = new WorkspaceRuntimeScope('legacy_ts');
  await expect(legacy.enter(join(root, 'profile-b', 'index.db'), 'legacy', [project])).rejects.toThrow('another runtime');
  await native.close(true);
  await legacy.enter(join(root, 'profile-b', 'index.db'), 'legacy', [project]);
  await legacy.close(true);
  await expect(native.invoke(tool(), async () => ({ content: 'late', isError: false }))).rejects.toThrow('closed');
});

it('rolls back only its shared reservation when the compatibility profile has an older owner', async () => {
  const older = await store().acquire('older-worker', 'legacy_ts', [project]);
  const native = new WorkspaceRuntimeScope('rust_v1');
  await expect(native.enter(join(root, 'index.db'), 'native', [project])).rejects.toThrow('another runtime');
  const ledger = JSON.parse(await readFile(join(root, 'shared', 'workspace-cohorts', 'claims.json'), 'utf8'));
  expect(ledger.state.claims).toEqual([]);
  expect(JSON.parse(await readFile(join(directory, 'claims.json'), 'utf8')).state.claims).toEqual([older]);
});

it('retains uncertain effects in both shared and compatibility ledgers', async () => {
  const native = new WorkspaceRuntimeScope('rust_v1');
  await native.enter(join(root, 'index.db'), 'native', [project]);
  await native.invoke(tool(), async () => ({ content: 'lost acknowledgement', isError: true, effectOutcome: 'unknown' }));
  await native.close(true);
  for (const path of [directory, join(root, 'shared', 'workspace-cohorts')]) {
    expect(JSON.parse(await readFile(join(path, 'claims.json'), 'utf8')).state.claims[0].reconciliation).toContain('Uncertain');
  }
  await expect(new WorkspaceRuntimeScope('legacy_ts').enter(join(root, 'other', 'index.db'), 'other', [project]))
    .rejects.toThrow('another runtime');
});

it('atomically admits only one generation under a concurrent race and preserves same-generation Company concurrency', async () => {
  const requests = await Promise.allSettled([store().acquire('legacy', 'legacy_ts', [project]), store().acquire('native', 'rust_v1', [project])]);
  expect(requests.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const winner = requests.find(result => result.status === 'fulfilled')! as PromiseFulfilledResult<Awaited<ReturnType<WorkspaceRuntimeCohortStore['acquire']>>>;
  const same = await store().acquire('same-tree-child', winner.value.generation, [project]);
  await store().release(winner.value, async () => {});
  await expect(store().acquire('other', same.generation === 'rust_v1' ? 'legacy_ts' : 'rust_v1', [project])).rejects.toThrow('another runtime');
  await store().release(same, async () => {});
  await expect(store().acquire('other', same.generation === 'rust_v1' ? 'legacy_ts' : 'rust_v1', [project])).resolves.toBeDefined();
});

it('blocks ancestor and descendant roots, without confusing sibling name prefixes', async () => {
  const nested = join(project, 'nested'); const sibling = join(root, 'project-other');
  await mkdir(nested); await mkdir(sibling);
  await store().acquire('legacy', 'legacy_ts', [nested]);
  await expect(store().acquire('native', 'rust_v1', [project])).rejects.toThrow('another runtime');
  await expect(store().acquire('native', 'rust_v1', [sibling])).resolves.toBeDefined();
});

it('never expires a crashed writer or releases it after an unsuccessful cleanup proof', async () => {
  const claim = await store().acquire('legacy', 'legacy_ts', [project]);
  await expect(store().release(claim, async () => { throw new Error('child still alive'); })).rejects.toThrow('child still alive');
  await expect(store().acquire('native', 'rust_v1', [project])).rejects.toThrow('another runtime');
  await store().retain(claim, 'lost acknowledgement');
  await store().release(claim, async () => {});
  await expect(store().acquire('native', 'rust_v1', [project])).rejects.toThrow('another runtime');
});

it('checks an additional external root before extending a running session grant', async () => {
  const external = join(root, 'external'); await mkdir(external);
  const legacy = await store().acquire('legacy', 'legacy_ts', [project]);
  const native = await store().acquire('native', 'rust_v1', [external]);
  await expect(store().extend(legacy, external)).rejects.toThrow('conflicts');
  await store().release(native, async () => {});
  const expanded = await store().extend(legacy, external);
  expect(expanded.roots).toHaveLength(2);
  await expect(store().acquire('native', 'rust_v1', [external])).rejects.toThrow('another runtime');
  await store().release(expanded, async () => {});
});

it('rejects a deleted or corrupted ledger instead of reconstructing empty ownership', async () => {
  await store().acquire('legacy', 'legacy_ts', [project]);
  const path = join(directory, 'claims.json');
  const valid = await readFile(path);
  await unlink(path);
  await expect(store().acquire('native', 'rust_v1', [project])).rejects.toThrow();
  const changed = JSON.parse(valid.toString()); changed.state.claims = [];
  await writeFile(path, JSON.stringify(changed));
  await expect(store().acquire('native', 'rust_v1', [project])).rejects.toThrow('Corrupt');
});

it('waits for a real in-flight filesystem handler before admitting the other runtime', async () => {
  const scope = new WorkspaceRuntimeScope('legacy_ts');
  await scope.enter(join(root, 'index.db'), 'legacy', [project]);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const registry = new ToolRegistry();
  registry.register(tool({ effectBoundary: 'filesystem', mutates: true, parallelSafe: false, riskLevel: 'write',
    handler: async () => { entered(); await gate; return { content: 'written', isError: false }; } }));
  const invoked = registry.invoke('fixture', {}, { cwd: project, projectName: 'fixture', workspaceRuntimeScope: scope });
  await started;
  const closed = scope.close(true);
  try { await expect(store().acquire('native', 'rust_v1', [project])).rejects.toThrow('another runtime'); }
  finally { release(); await invoked; await closed; }
  await expect(store().acquire('native', 'rust_v1', [project])).resolves.toBeDefined();
});

it.each(['legacy_ts', 'rust_v1'] as const)('retains %s ownership after an unknown capability result', async generation => {
  const scope = new WorkspaceRuntimeScope(generation);
  await scope.enter(join(root, 'index.db'), 'owner', [project]);
  await scope.invoke(tool({ effectBoundary: 'filesystem' }), async () => ({ content: 'lost ACK', isError: true, effectOutcome: 'unknown' }));
  await scope.close(true);
  await expect(store().acquire('other', generation === 'rust_v1' ? 'legacy_ts' : 'rust_v1', [project])).rejects.toThrow('another runtime');
});

it('retains an uncontained legacy command before invoking it and allows its inherited background context to finish', async () => {
  const scope = new WorkspaceRuntimeScope('legacy_ts');
  await scope.enter(join(root, 'index.db'), 'legacy', [project]);
  const command = tool({ effectBoundary: 'shell', mutates: true, parallelSafe: false, riskLevel: 'execute' });
  await scope.invoke(command, async () => {
    expect(JSON.parse(await readFile(join(directory, 'claims.json'), 'utf8')).state.claims[0].reconciliation).toContain('Uncontained');
    return { content: 'background started', isError: false };
  });
  await scope.close(true);
  const background = vi.fn(async () => ({ content: 'background complete', isError: false }));
  await scope.invoke(tool(), background);
  expect(background).toHaveBeenCalledOnce();
  await expect(store().acquire('native', 'rust_v1', [project])).rejects.toThrow('another runtime');
});
