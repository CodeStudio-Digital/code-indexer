import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relToAbsCanonical } from '@mcp/shared/utils/fs-canonical.js';

const mocked = vi.hoisted(() => ({ handles: [] as Array<{
  state: string;
  spec: { cwd: string; rootPath: string };
  hooks: { onDiagnostics: (path: string, diagnostics: unknown[]) => void };
  didOpen: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> }));

vi.mock('../lsp-server-handle.js', () => ({
  LspServerHandle: class MockLspServerHandle {
    state = 'starting';
    stderrTail = '';
    didOpen = vi.fn();
    stop = vi.fn(async () => { this.state = 'stopped'; });
    constructor(
      readonly spec: { cwd: string; rootPath: string },
      readonly hooks: { onDiagnostics: (path: string, diagnostics: unknown[]) => void },
    ) {
      mocked.handles.push(this);
    }
    async whenReady(): Promise<void> { this.state = 'ready'; }
    requestStats() {
      return { queued: 0, inFlight: 0, backgroundInFlight: 0, cancelled: 0, superseded: 0 };
    }
  },
}));

import { LspServerManager, type LspRouteIdentity } from '../lsp-server-manager.js';
import { defineLspRoute } from '../lsp-route.js';
import { installDirFor, serverById } from '../server-registry.js';

const tmps: string[] = [];
const managers: LspServerManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  mocked.handles.length = 0;
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'mcp-lsp-routes-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-lsp-project-'));
  tmps.push(baseDir, projectRoot);
  const legacyRoot = join(projectRoot, 'apps', 'legacy');
  const modernRoot = join(projectRoot, 'apps', 'modern');
  mkdirSync(join(legacyRoot, 'src'), { recursive: true });
  mkdirSync(join(modernRoot, 'src'), { recursive: true });
  writeFileSync(join(legacyRoot, 'src', 'app.ts'), 'export const legacy = true;');
  writeFileSync(join(modernRoot, 'src', 'app.ts'), 'export const modern = true;');

  const def = serverById('intelephense')!;
  if (def.install.kind !== 'npm') throw new Error('intelephense fixture requires an npm server');
  const installDir = installDirFor(baseDir, def);
  const entry = join(installDir, def.entryRelPath!);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, 'stub');
  const packageJson = join(installDir, 'node_modules', def.install.package, 'package.json');
  mkdirSync(dirname(packageJson), { recursive: true });
  writeFileSync(packageJson, JSON.stringify({ name: def.install.package, version: def.install.version }));

  const diagnostics = vi.fn();
  const routeRetired = vi.fn();
  const manager = new LspServerManager({
    baseDir,
    resolveNodeBin: () => null,
    resolveRoot: () => projectRoot,
    resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
    docsForReplay: () => [
      { file: 'apps/legacy/src/app.ts', languageId: 'php', version: 1, content: 'legacy' },
      { file: 'apps/modern/src/app.ts', languageId: 'php', version: 1, content: 'modern' },
    ],
    onDiagnostics: diagnostics,
    onRouteRetired: routeRetired,
  });
  managers.push(manager);
  return { manager, def, diagnostics, routeRetired, baseDir, projectRoot, legacyRoot, modernRoot };
}

function route(profileId: string, fingerprint: string, workspaceRoot: string): LspRouteIdentity {
  return { familyId: 'angular', profileId, workspaceFingerprint: fingerprint, workspaceRoot };
}

describe('LspServerManager routed instances', () => {
  it('creates deterministic path-free ids and replays only the owning workspace', async () => {
    const { manager, def, projectRoot, legacyRoot, modernRoot } = fixture();
    const identity = route('v12', 'workspace-legacy', legacyRoot);
    const descriptor = defineLspRoute(identity);
    const sameFingerprintElsewhere = defineLspRoute({ ...identity, workspaceRoot: join(projectRoot, 'elsewhere') });

    expect(descriptor.routeId).toBe(sameFingerprintElsewhere.routeId);
    expect(descriptor.routeId).toMatch(/^lsp-route:angular:v12:[a-f0-9]{24}$/);
    expect(descriptor.routeId).not.toContain(projectRoot);
    expect(descriptor.routeId).not.toContain('legacy');

    const acquired = await manager.acquireById(7, def.id, 'manual', identity);
    expect(acquired).toMatchObject({ routeId: descriptor.routeId, familyId: 'angular', profileId: 'v12', root: legacyRoot });
    expect(mocked.handles).toHaveLength(1);
    expect(mocked.handles[0]!.spec).toMatchObject({ cwd: legacyRoot, rootPath: legacyRoot });
    expect(mocked.handles[0]!.didOpen).toHaveBeenCalledOnce();
    expect(mocked.handles[0]!.didOpen.mock.calls[0]![0]).toBe(relToAbsCanonical(projectRoot, 'apps/legacy/src/app.ts'));
    expect(manager.statusByRouteId(7, descriptor.routeId)).toMatchObject({ state: 'ready', routeId: descriptor.routeId });
    await expect(manager.acquireById(7, def.id, 'manual', { ...identity, workspaceRoot: modernRoot }))
      .rejects.toThrow('LSP route identity collision');
  });

  it('isolates ready, diagnostics, stop and reacquire by route id', async () => {
    const { manager, def, diagnostics, legacyRoot, modernRoot } = fixture();
    const legacy = await manager.acquireById(7, def.id, 'manual', route('v12', 'legacy-fp', legacyRoot));
    const modern = await manager.acquireById(7, def.id, 'manual', route('v21', 'modern-fp', modernRoot));
    expect(legacy?.routeId).toBeTruthy();
    expect(modern?.routeId).toBeTruthy();
    expect(legacy?.routeId).not.toBe(modern?.routeId);
    expect(mocked.handles).toHaveLength(2);
    expect(manager.routeTarget(7, legacy!.routeId!)).toMatchObject({
      serverId: def.id,
      familyId: 'angular',
      profileId: 'v12',
      workspaceRoot: legacyRoot,
    });

    const ready: string[] = [];
    manager.forEachReady(7, (_handle, _server, root, routeId) => ready.push(`${root}:${routeId}`), legacy!.routeId);
    expect(ready).toEqual([`${legacyRoot}:${legacy!.routeId}`]);

    mocked.handles[0]!.hooks.onDiagnostics(join(legacyRoot, 'src', 'app.ts'), []);
    expect(diagnostics).toHaveBeenLastCalledWith(7, join(legacyRoot, 'src', 'app.ts'), def.id, [], legacy!.routeId);

    await expect(manager.stopRoute(7, legacy!.routeId!)).resolves.toBe(true);
    expect(mocked.handles[0]!.stop).toHaveBeenCalledOnce();
    expect(mocked.handles[1]!.stop).not.toHaveBeenCalled();
    expect(manager.statusByRouteId(7, legacy!.routeId!)).toMatchObject({ state: 'idle' });
    expect(manager.statusByRouteId(7, modern!.routeId!)).toMatchObject({ state: 'ready' });

    const reacquired = await manager.acquireByRouteId(7, legacy!.routeId!);
    expect(reacquired?.routeId).toBe(legacy!.routeId);
    expect(mocked.handles).toHaveLength(3);
  });

  it('retires only affected routes, clears their diagnostics and rejects late frames', async () => {
    const { manager, def, diagnostics, routeRetired, legacyRoot, modernRoot } = fixture();
    const legacy = await manager.acquireById(7, def.id, 'manual', route('v12', 'legacy-fp', legacyRoot));
    const modern = await manager.acquireById(7, def.id, 'manual', route('v21', 'modern-fp', modernRoot));
    diagnostics.mockClear();

    await expect(manager.retireRoutes(7, 'angular', join(legacyRoot, 'package.json')))
      .resolves.toBe(1);
    expect(mocked.handles[0]!.stop).toHaveBeenCalledOnce();
    expect(mocked.handles[1]!.stop).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledWith(
      7,
      relToAbsCanonical(legacyRoot, 'src/app.ts'),
      def.id,
      [],
      legacy!.routeId,
    );
    expect(routeRetired).toHaveBeenCalledWith(7, def.id, legacy!.routeId);
    await expect(manager.acquireByRouteId(7, legacy!.routeId!)).resolves.toBeNull();
    expect(manager.statusByRouteId(7, modern!.routeId!)).toMatchObject({ state: 'ready' });

    diagnostics.mockClear();
    manager.statusById(7, def.id, 'php', route('v12', 'legacy-fp', legacyRoot));
    mocked.handles[0]!.hooks.onDiagnostics(join(legacyRoot, 'src', 'app.ts'), [{ message: 'late' }]);
    expect(diagnostics).not.toHaveBeenCalled();

    const renewed = await manager.acquireById(
      7,
      def.id,
      'manual',
      route('v12', 'legacy-fp', legacyRoot),
    );
    mocked.handles[2]!.hooks.onDiagnostics(join(legacyRoot, 'src', 'app.ts'), []);
    expect(diagnostics).toHaveBeenCalledWith(
      7,
      join(legacyRoot, 'src', 'app.ts'),
      def.id,
      [],
      renewed!.routeId,
    );
  });

  it('clears diagnostics for every routed instance before uninstalling its server', async () => {
    const { manager, def, diagnostics, projectRoot, legacyRoot, modernRoot } = fixture();
    const legacy = await manager.acquireById(7, def.id, 'manual', route('v12', 'legacy-fp', legacyRoot));
    const modern = await manager.acquireById(7, def.id, 'manual', route('v21', 'modern-fp', modernRoot));
    diagnostics.mockClear();

    await expect(manager.uninstallServer(def.id, () => true)).resolves.toBe(true);

    expect(diagnostics.mock.calls).toEqual(expect.arrayContaining([
      [7, relToAbsCanonical(projectRoot, 'apps/legacy/src/app.ts'), def.id, [], legacy!.routeId],
      [7, relToAbsCanonical(projectRoot, 'apps/modern/src/app.ts'), def.id, [], modern!.routeId],
    ]));
    expect(diagnostics).toHaveBeenCalledTimes(2);
  });

  it('reports a routed restart failure when the server cannot be acquired again', async () => {
    const { manager, def, baseDir, legacyRoot } = fixture();
    const acquired = await manager.acquireById(
      7, def.id, 'manual', route('v12', 'legacy-fp', legacyRoot),
    );
    rmSync(installDirFor(baseDir, def), { recursive: true, force: true });

    await expect(manager.restartRoute(7, acquired!.routeId!)).resolves.toBe(false);
  });

  it('keeps the legacy project/server instance and full-project replay without a route', async () => {
    const { manager, def } = fixture();
    const first = await manager.acquireById(7, def.id);
    const second = await manager.acquireById(7, def.id);

    expect(first?.routeId).toBeUndefined();
    expect(second?.handle).toBe(first?.handle);
    expect(mocked.handles).toHaveLength(1);
    expect(mocked.handles[0]!.didOpen).toHaveBeenCalledTimes(2);
    expect(manager.listInstances()).toEqual([
      expect.objectContaining({ projectId: 7, serverId: def.id, routeId: undefined }),
    ]);
  });
});
