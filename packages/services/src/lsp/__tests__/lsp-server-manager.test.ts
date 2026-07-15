import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LspServerManager } from '../lsp-server-manager.js';
import { binaryAssetFor, installDirFor, serverById } from '../server-registry.js';

const tmps: string[] = [];
afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('LspServerManager activation', () => {
  it('keeps OmniSharp idle for status/open/background and shares one interactive cold start', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'mcp-lsp-manager-'));
    tmps.push(baseDir);
    const def = serverById('omnisharp')!;
    const installDir = installDirFor(baseDir, def);
    const bin = binaryAssetFor(def)!.binRelPath;
    mkdirSync(join(installDir, bin, '..'), { recursive: true });
    writeFileSync(join(installDir, bin), 'stub');
    const manager = new LspServerManager({
      baseDir,
      resolveNodeBin: () => null,
      resolveRoot: () => '/project',
      resolveRuntime: (_projectId, requirement) => ({
        ...requirement, satisfied: true, command: 'dotnet', version: '8.0.100',
      }),
      docsForReplay: () => [],
      onDiagnostics: () => undefined,
    });

    expect(manager.status(7, 'csharp').state).toBe('idle');
    await expect(manager.acquire(7, 'csharp', 'status')).resolves.toBeNull();
    await expect(manager.acquire(7, 'csharp', 'open')).resolves.toBeNull();
    await expect(manager.acquire(7, 'csharp', 'background')).resolves.toBeNull();
    expect(manager.listInstances()).toEqual([]);

    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const handle = { state: 'ready' };
    const spawn = vi.fn(async () => { await ready; return handle; });
    (manager as unknown as { spawn: typeof spawn }).spawn = spawn;
    const first = manager.acquire(7, 'csharp', 'interactive');
    const second = manager.acquire(7, 'csharp', 'manual');
    expect(spawn).toHaveBeenCalledOnce();
    release();

    await expect(first).resolves.toEqual(expect.objectContaining({ handle, def }));
    await expect(second).resolves.toEqual(expect.objectContaining({ handle, def }));
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe('LspServerManager uninstall', () => {
  it('stops every live instance before removing the server files', async () => {
    const manager = new LspServerManager({
      resolveNodeBin: () => null,
      resolveRoot: () => null,
      resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
      docsForReplay: () => [],
      onDiagnostics: () => undefined,
    });
    const events: string[] = [];
    const stopFirst = vi.fn(async () => { events.push('stopped'); });
    const stopSecond = vi.fn(async () => { events.push('stopped'); });
    const entries = (manager as unknown as { entries: Map<string, unknown> }).entries;
    entries.set('76:omnisharp', {
      def: serverById('omnisharp')!,
      projectId: 76,
      handle: { state: 'ready', stop: stopFirst },
      spawning: null,
      crashTimes: [],
      idleTimer: null,
    });
    entries.set('91:omnisharp', {
      def: serverById('omnisharp')!,
      projectId: 91,
      handle: { state: 'ready', stop: stopSecond },
      spawning: null,
      crashTimes: [],
      idleTimer: null,
    });

    const removed = await manager.uninstallServer('omnisharp', () => {
      events.push('removed');
      return true;
    });

    expect(removed).toBe(true);
    expect(events).toEqual(['stopped', 'stopped', 'removed']);
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
    expect(entries.size).toBe(0);
  });

  it('stops and removes only the instances owned by the project that left', async () => {
    const manager = new LspServerManager({
      resolveNodeBin: () => null,
      resolveRoot: () => null,
      resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
      docsForReplay: () => [],
      onDiagnostics: () => undefined,
    });
    const stopOmnisharp = vi.fn(async () => undefined);
    const stopIntelephense = vi.fn(async () => undefined);
    const stopOtherProject = vi.fn(async () => undefined);
    const entries = (manager as unknown as { entries: Map<string, unknown> }).entries;
    const entry = (projectId: number, serverId: string, stop: () => Promise<void>) => ({
      def: serverById(serverId)!, projectId, handle: {
        state: 'ready', stop,
        requestStats: () => ({ queued: 0, inFlight: 0, backgroundInFlight: 0, cancelled: 0, superseded: 0 }),
      },
      spawning: null, crashTimes: [], idleTimer: null,
    });
    entries.set('76:omnisharp', entry(76, 'omnisharp', stopOmnisharp));
    entries.set('76:intelephense', entry(76, 'intelephense', stopIntelephense));
    entries.set('7:omnisharp', entry(7, 'omnisharp', stopOtherProject));

    await manager.stopProject(76);

    expect(stopOmnisharp).toHaveBeenCalledOnce();
    expect(stopIntelephense).toHaveBeenCalledOnce();
    expect(stopOtherProject).not.toHaveBeenCalled();
    expect(manager.listInstances()).toEqual([
      expect.objectContaining({ projectId: 7, serverId: 'omnisharp' }),
    ]);
  });
});

describe('LspServerManager warm LRU', () => {
  it('keeps at most two inactive server instances and evicts the oldest', async () => {
    const previous = process.env.MCP_LSP_WARM_PROJECTS;
    process.env.MCP_LSP_WARM_PROJECTS = '2';
    try {
      const manager = new LspServerManager({
        resolveNodeBin: () => null,
        resolveRoot: () => '/project',
        resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
        docsForReplay: () => [], onDiagnostics: () => undefined,
      });
      const stopped = [vi.fn(async () => undefined), vi.fn(async () => undefined), vi.fn(async () => undefined)];
      const entries = (manager as unknown as { entries: Map<string, unknown> }).entries;
      const entry = (projectId: number, stop: () => Promise<void>) => ({
        def: serverById('omnisharp')!, projectId,
        handle: { state: 'ready', stop, requestStats: () => ({ queued: 0, inFlight: 0, backgroundInFlight: 0, cancelled: 0, superseded: 0 }) },
        spawning: null, crashTimes: [], idleTimer: null,
      });
      entries.set('1:omnisharp', entry(1, stopped[0]));
      entries.set('2:omnisharp', entry(2, stopped[1]));
      entries.set('3:omnisharp', entry(3, stopped[2]));

      await manager.parkProject(1);
      await manager.parkProject(2);
      await manager.parkProject(3);

      expect(stopped[0]).toHaveBeenCalledOnce();
      expect(stopped[1]).not.toHaveBeenCalled();
      expect(stopped[2]).not.toHaveBeenCalled();
      expect(manager.listInstances().map((instance) => instance.projectId)).toEqual([2, 3]);
      expect(manager.listInstances()[0]).toMatchObject({ inactive: true, lruEvictions: 1 });
    } finally {
      if (previous === undefined) delete process.env.MCP_LSP_WARM_PROJECTS;
      else process.env.MCP_LSP_WARM_PROJECTS = previous;
    }
  });
});
