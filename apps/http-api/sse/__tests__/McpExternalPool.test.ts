import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { McpExternalPool } from '../McpExternalPool.js';

function server(updatedAt = '2026-08-02T00:00:00.000Z'): McpServerConfig {
  return {
    id: 'unity',
    name: 'Unity',
    transport: 'streamable_http',
    enabled: true,
    url: 'http://127.0.0.1:8765/mcp',
    command: null,
    args: [],
    env: {},
    auth_type: 'none',
    auth_token: null,
    default_tier: 'unity',
    config: {},
    created_at: '2026-08-02T00:00:00.000Z',
    updated_at: updatedAt,
  };
}

function unityTool(): CoderTool {
  return {
    name: 'ext_unity__get_server_health',
    description: 'Get Unity broker health.',
    parameters: { type: 'object', properties: {} },
    source: 'mcp_external',
    mutates: false,
    handler: async () => ({ content: 'ok' }),
  };
}

function fakeManager(isOnline: () => boolean): {
  manager: McpServerManager;
  connectAll: ReturnType<typeof vi.fn>;
  closeAll: ReturnType<typeof vi.fn>;
  closeServer: ReturnType<typeof vi.fn>;
} {
  const states = new Map<string, { state: 'connected' | 'error'; error?: string }>();
  const connectAll = vi.fn(async (configs: McpServerConfig[]) => {
    states.clear();
    for (const config of configs) {
      states.set(config.id, isOnline()
        ? { state: 'connected' }
        : { state: 'error', error: 'ECONNREFUSED' });
    }
  });
  const closeAll = vi.fn(async () => { states.clear(); });
  const closeServer = vi.fn(async (serverId: string) => { states.delete(serverId); });
  const connectServer = vi.fn(async (config: McpServerConfig) => {
    states.set(config.id, isOnline()
      ? { state: 'connected' }
      : { state: 'error', error: 'ECONNREFUSED' });
    if (!isOnline()) throw new Error('ECONNREFUSED');
  });
  const manager = {
    connectAll,
    connectServer,
    refreshAll: vi.fn(),
    closeAll,
    closeServer,
    listAllTools: vi.fn(async () => isOnline()
      ? {
        tools: [unityTool()],
        tierMap: new Map([['ext_unity__get_server_health', 'unity']]),
      }
      : { tools: [], tierMap: new Map() }),
    getConnectionStates: () => new Map(states),
    getCustomTierSummary: () => isOnline()
      ? new Map([['unity', { displayName: 'Unity', toolCount: 1 }]])
      : new Map(),
    listStdioProcesses: () => [],
  } as unknown as McpServerManager;
  Object.defineProperty(manager, 'connectedCount', {
    get: () => [...states.values()].filter((state) => state.state === 'connected').length,
  });
  return { manager, connectAll, closeAll, closeServer };
}

const pools: McpExternalPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

describe('McpExternalPool readiness reconciliation', () => {
  it('rechecks catalogue revision after delayed transport preparation', async () => {
    let config = server(); const fake = fakeManager(() => true);
    let release!: () => void, effects = 0;
    const handler = vi.fn(async (_args, ctx) => {
      await new Promise<void>(r => { release = r; });
      try { ctx.assertExternalMcpDispatch(); }
      catch { return { isError: true, content: 'catalogue retired' }; }
      effects++; return { content: 'ok' };
    });
    vi.mocked(fake.manager.listAllTools).mockResolvedValue({ tools: [{ ...unityTool(), handler }], tierMap: new Map() });
    const pool = new McpExternalPool({ dbPath: ':memory:', manager: fake.manager, loadEnabledServers: () => [config] });
    pools.push(pool); await pool.boot();
    const pending = pool.callTool('unity', 'get_server_health', {}, undefined, pool.getSnapshot().tools[0].catalogueRevision);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    config = { ...config, url: config.url + '/changed' }; await pool.getReadySnapshot(); release();
    expect(await pending).toMatchObject({ ok: false });
    expect(effects).toBe(0);
  });

  it('binds worker and in-process handlers to the admitted catalogue revision', async () => {
    let config = server(); const fake = fakeManager(() => true);
    const handler = vi.fn(async () => ({ content: 'ok' }));
    vi.mocked(fake.manager.listAllTools).mockResolvedValue({ tools: [{ ...unityTool(), handler }], tierMap: new Map() });
    const pool = new McpExternalPool({ dbPath: ':memory:', manager: fake.manager, loadEnabledServers: () => [config] });
    pools.push(pool); await pool.boot();
    const oldRevision = pool.getSnapshot().tools[0].catalogueRevision!;
    const oldHandler = (await pool.listAllTools()).tools[0].handler;
    await pool.getReadySnapshot();
    expect(pool.getSnapshot().tools[0].catalogueRevision).toBe(oldRevision);
    // Even an edit with an unchanged timestamp must invalidate the admitted configuration.
    config = { ...config, url: config.url + '/changed' };
    await pool.getReadySnapshot();
    const currentRevision = pool.getSnapshot().tools[0].catalogueRevision!;
    expect(currentRevision).not.toBe(oldRevision);
    expect((await pool.callTool('unity', 'get_server_health', {}, undefined, oldRevision)).ok).toBe(false);
    expect(await oldHandler({}, {} as import('@mcp/code-agent/core/tool.js').ToolContext)).toMatchObject({ isError: true });
    expect(handler).not.toHaveBeenCalled();
    expect((await pool.callTool('unity', 'get_server_health', {}, undefined, currentRevision)).ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispatches without catalogue network requests and preserves the complete result', async () => {
    const fake = fakeManager(() => true);
    const result = { content: 'frame', structuredData: { revision: 7 },
      extraUserBlocks: [{ type: 'image' as const, mediaType: 'image/png', base64: 'aW1hZ2U=' }] };
    const handler = vi.fn(async () => result);
    vi.mocked(fake.manager.listAllTools).mockResolvedValue({ tools: [{ ...unityTool(), handler }], tierMap: new Map() });
    const pool = new McpExternalPool({ dbPath: ':memory:', manager: fake.manager, loadEnabledServers: () => [server()] });
    pools.push(pool);
    await pool.boot();
    const lists = vi.mocked(fake.manager.listAllTools).mock.calls.length;
    for (let i = 0; i < 4; i++) {
      expect(await pool.callTool('unity', 'get_server_health', {})).toEqual({ ok: true, text: 'frame', result });
    }
    expect(handler).toHaveBeenCalledTimes(4);
    expect(fake.manager.listAllTools).toHaveBeenCalledTimes(lists);
  });
  it('detects a Unity config created after an empty process boot', async () => {
    let configs: McpServerConfig[] = [];
    const fake = fakeManager(() => true);
    const pool = new McpExternalPool({
      dbPath: ':memory:',
      manager: fake.manager,
      loadEnabledServers: () => configs,
    });
    pools.push(pool);

    await pool.boot();
    expect(pool.getSnapshot().enabledServers).toEqual([]);
    expect(fake.connectAll).not.toHaveBeenCalled();

    configs = [server()];
    const recovered = await pool.getReadySnapshot();

    expect(fake.connectAll).toHaveBeenCalledTimes(1);
    expect(recovered.enabledServers.map((entry) => entry.id)).toEqual(['unity']);
    expect(recovered.tools.map((tool) => tool.name)).toContain(
      'ext_unity__get_server_health',
    );
  });

  it('recovers an initially refused broker once and shares the recovered snapshot', async () => {
    let online = false;
    const fake = fakeManager(() => online);
    const pool = new McpExternalPool({
      dbPath: ':memory:',
      manager: fake.manager,
      loadEnabledServers: () => [server()],
    });
    pools.push(pool);

    await pool.boot();
    expect(pool.getSnapshot().tools).toEqual([]);
    expect(fake.connectAll).toHaveBeenCalledTimes(1);

    online = true;
    const snapshots = await Promise.all([
      pool.getReadySnapshot(),
      pool.getReadySnapshot(),
      pool.getReadySnapshot(),
    ]);

    expect(fake.closeAll).not.toHaveBeenCalled();
    expect(fake.closeServer).toHaveBeenCalledTimes(1);
    expect(fake.connectAll).toHaveBeenCalledTimes(1);
    expect(snapshots.every((snapshot) =>
      snapshot.tools.some((tool) => tool.name === 'ext_unity__get_server_health'))).toBe(true);
  });

  it('keeps healthy connections warm but rebuilds when persisted config changes', async () => {
    let config = server();
    const fake = fakeManager(() => true);
    const pool = new McpExternalPool({
      dbPath: ':memory:',
      manager: fake.manager,
      loadEnabledServers: () => [config],
    });
    pools.push(pool);

    await pool.boot();
    await pool.getReadySnapshot();
    await pool.getReadySnapshot();
    expect(fake.connectAll).toHaveBeenCalledTimes(1);
    expect(fake.closeAll).not.toHaveBeenCalled();

    config = { ...config, updated_at: '2026-08-02T00:01:00.000Z' };
    await pool.getReadySnapshot();
    expect(fake.closeAll).toHaveBeenCalledTimes(1);
    expect(fake.connectAll).toHaveBeenCalledTimes(2);
  });
});
