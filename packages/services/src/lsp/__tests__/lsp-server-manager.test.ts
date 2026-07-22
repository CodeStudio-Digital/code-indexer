import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSupportedLspNodeVersion,
  lspNodeRuntimeStatus,
  LspServerManager,
} from '../lsp-server-manager.js';
import {
  binaryAssetFor,
  installDirFor,
  replacePluginLanguageServers,
  serverById,
} from '../server-registry.js';

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

describe('LspServerManager Node policy', () => {
  const ranges = {
    ng9: '>=10.9.0 <13.0.0',
    ng12: '>=10.9.0 <15.0.0',
    ng13: '^12.20.0 || ^14.15.0 || >=16.10.0',
    ng21: '^20.19.0 || ^22.12.0 || >=24.0.0',
    ng22: '^22.22.3 || ^24.15.0 || >=26.0.0',
  } as const;

  it.each([
    ['ng9', ranges.ng9, ['10.9.0', '12.22.12'], ['10.8.9', '13.0.0']],
    ['ng12', ranges.ng12, ['12.22.12', '14.21.3'], ['10.8.9', '15.0.0']],
    ['ng13', ranges.ng13, ['12.20.0', '14.15.0', '16.10.0', '22.0.0'], ['12.19.9', '13.9.0', '14.14.9']],
    ['ng21', ranges.ng21, ['20.19.0', '22.12.0', '24.0.0'], ['20.18.9', '21.7.3', '22.11.0', '23.10.0']],
    ['ng22', ranges.ng22, ['22.22.3', '24.15.0', '26.0.0'], ['22.22.2', '23.9.0', '24.14.9', '25.0.0']],
  ])('enforces the %s profile Node range', (_profile, range, accepted, rejected) => {
    for (const version of accepted) expect(isSupportedLspNodeVersion(version, range), version).toBe(true);
    for (const version of rejected) expect(isSupportedLspNodeVersion(version, range), version).toBe(false);
  });

  it('reads the managed runtime version from its bin path', () => {
    expect(isSupportedLspNodeVersion('C:\\managed\\node\\v20.19.5\\bin', ranges.ng21)).toBe(true);
    expect(isSupportedLspNodeVersion('/managed/node/v22.11.0/bin', ranges.ng21)).toBe(false);
    expect(isSupportedLspNodeVersion('/managed/node/v18.20.4/bin', serverById('intelephense')!)).toBe(true);
  });

  it('reports the compatible project runtime before spawning', () => {
    const def = { ...serverById('intelephense')!, serverNodeRange: ranges.ng9 };
    expect(lspNodeRuntimeStatus(
      { resolveNodeBin: () => '/managed/node/v12.22.12/bin' },
      7,
      def,
    )).toEqual({
      range: ranges.ng9,
      satisfied: true,
      source: 'project',
      version: '12.22.12',
    });
  });

  it('probes a selected Node executable when its directory has no version token', () => {
    const def = { ...serverById('intelephense')!, serverNodeRange: '>=1.0.0' };
    expect(lspNodeRuntimeStatus(
      { resolveNodeBin: () => dirname(process.execPath) },
      7,
      def,
    )).toMatchObject({
      satisfied: true,
      source: 'project',
      version: process.versions.node,
    });
  });

  it('explains when neither project nor app Node satisfies the profile', () => {
    const range = '>=99.0.0 <100.0.0';
    const def = { ...serverById('intelephense')!, serverNodeRange: range };
    expect(lspNodeRuntimeStatus(
      { resolveNodeBin: () => '/managed/node/v12.22.12/bin' },
      7,
      def,
    )).toEqual(expect.objectContaining({
      range,
      satisfied: false,
      version: '12.22.12',
      reason: expect.stringContaining(`project Node 12.22.12 and app Node ${process.versions.node}`),
    }));
  });

  it('selects a managed runtime only after the effective profile range passes', () => {
    const nodeBin = process.platform === 'win32'
      ? 'C:\\managed\\node\\v20.19.0'
      : '/managed/node/v20.19.0/bin';
    const manager = new LspServerManager({
      resolveNodeBin: () => nodeBin,
      resolveRoot: () => '/project',
      resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
      docsForReplay: () => [],
      onDiagnostics: () => undefined,
    });
    const def = { ...serverById('intelephense')!, serverNodeRange: ranges.ng21 };
    const resolved = (manager as unknown as {
      resolveServerNode(projectId: number, selected: typeof def): { command: string };
    }).resolveServerNode(7, def);
    expect(resolved.command).toBe(join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'));
  });

  it('blocks with the exact profile range when managed and app Node are incompatible', () => {
    const manager = new LspServerManager({
      resolveNodeBin: () => '/managed/node/v20.19.0/bin',
      resolveRoot: () => '/project',
      resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
      docsForReplay: () => [],
      onDiagnostics: () => undefined,
    });
    const def = { ...serverById('intelephense')!, serverNodeRange: ranges.ng9 };
    const resolve = () => (manager as unknown as {
      resolveServerNode(projectId: number, selected: typeof def): { command: string };
    }).resolveServerNode(7, def);
    expect(resolve).toThrow(
      `language server requires Node ${ranges.ng9}; app runtime is ${process.versions.node}`,
    );
  });
});

describe('LspServerManager plugin route refresh', () => {
  const angularContribution = (version: string) => ({
    id: 'angular-language-server',
    label: 'Angular Language Service',
    languages: ['typescript', 'html'],
    routing: { mode: 'overlay' as const, priority: 100 },
    install: { kind: 'npm' as const, package: '@angular/language-server', version },
    entryRelPath: 'node_modules/@angular/language-server/index.js',
    launchKind: 'angular' as const,
    args: [],
    activation: { whenFiles: ['angular.json'] },
    sizeLabel: '~13 MB',
  });

  it('refreshes cached routes after a plugin server changes and disappears, even without a live instance', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'mcp-lsp-manager-'));
    const root = mkdtempSync(join(tmpdir(), 'mcp-angular-project-'));
    tmps.push(baseDir, root);
    writeFileSync(join(root, 'angular.json'), '{}');
    replacePluginLanguageServers([{ namespace: 'angular', contribution: angularContribution('21.2.18') }]);
    const refreshed: Array<{ languageId: string; state: string; serverId?: string; version?: string }> = [];
    let manager!: LspServerManager;
    manager = new LspServerManager({
      baseDir,
      resolveNodeBin: () => null,
      resolveRoot: () => root,
      resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
      docsForReplay: () => [],
      onDiagnostics: () => undefined,
      onRoutingChange: (projectId, languageId) => {
        const status = manager.status(projectId, languageId);
        refreshed.push({
          languageId,
          state: status.state,
          serverId: status.server?.id,
          version: status.server?.install.version,
        });
      },
    });

    try {
      expect(manager.status(7, 'typescript').server?.id).toBe('angular-language-server');
      expect(manager.status(7, 'html').server?.id).toBe('angular-language-server');

      const changed = replacePluginLanguageServers([
        { namespace: 'angular', contribution: angularContribution('21.2.19') },
      ]);
      expect(changed.changed).toEqual(['angular-language-server']);
      await manager.stopServer('angular-language-server');
      expect(refreshed).toEqual(expect.arrayContaining([
        expect.objectContaining({
          languageId: 'typescript',
          state: 'not-installed',
          serverId: 'angular-language-server',
          version: '21.2.19',
        }),
      ]));

      refreshed.length = 0;
      replacePluginLanguageServers([]);
      await manager.stopServer('angular-language-server');
      expect(refreshed).toEqual(expect.arrayContaining([
        { languageId: 'typescript', state: 'no-server', serverId: undefined, version: undefined },
        expect.objectContaining({ languageId: 'html', serverId: 'vscode-langservers' }),
      ]));
    } finally {
      replacePluginLanguageServers([]);
    }
  });
});

describe('LspServerManager uninstall', () => {
  it('publishes not-installed only after the server cache was removed', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'mcp-lsp-manager-'));
    const root = mkdtempSync(join(tmpdir(), 'mcp-angular-project-'));
    tmps.push(baseDir, root);
    writeFileSync(join(root, 'angular.json'), '{}');
    replacePluginLanguageServers([{
      namespace: 'angular',
      contribution: {
        id: 'angular-language-server',
        label: 'Angular Language Service',
        languages: ['typescript', 'html'],
        routing: { mode: 'overlay', priority: 100 },
        install: { kind: 'npm', package: '@angular/language-server', version: '21.2.18' },
        entryRelPath: 'node_modules/@angular/language-server/index.js',
        launchKind: 'angular',
        args: [],
        activation: { whenFiles: ['angular.json'] },
        sizeLabel: '~13 MB',
      },
    }]);
    const def = serverById('angular-language-server')!;
    const installDir = installDirFor(baseDir, def);
    const entry = join(installDir, def.entryRelPath!);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'stub');
    writeFileSync(join(dirname(entry), 'package.json'), JSON.stringify({
      name: '@angular/language-server',
      version: def.install.version,
    }));
    const events: string[] = [];
    let manager!: LspServerManager;
    manager = new LspServerManager({
      baseDir,
      resolveNodeBin: () => null,
      resolveRoot: () => root,
      resolveRuntime: (_projectId, requirement) => ({ ...requirement, satisfied: true }),
      docsForReplay: () => [],
      onDiagnostics: () => undefined,
      onRoutingChange: (projectId, languageId) => {
        events.push(`refresh:${languageId}:${manager.status(projectId, languageId).state}`);
      },
    });

    try {
      expect(manager.status(7, 'typescript').state).toBe('idle');
      const removed = await manager.uninstallServer('angular-language-server', () => {
        events.push('removed');
        rmSync(installDir, { recursive: true, force: true });
        return true;
      });
      expect(removed).toBe(true);
      expect(events).toEqual(['removed', 'refresh:typescript:not-installed']);
    } finally {
      replacePluginLanguageServers([]);
    }
  });

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
