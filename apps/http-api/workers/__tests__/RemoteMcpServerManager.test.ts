import { describe, expect, it, vi } from 'vitest';
import type { MessageBridge } from '@mcp/orchestrator-host';
import type { McpExternalSnapshot } from '../../sse/McpExternalPool.js';
import { RemoteMcpServerManager } from '../RemoteMcpServerManager.js';

function snapshot(withUnity: boolean): McpExternalSnapshot {
  return {
    tools: withUnity ? [{
      name: 'ext_unity__get_server_health',
      description: 'Get Unity broker health.',
      parameters: { type: 'object', properties: {} },
      repeatable: false,
      serverId: 'unity',
      toolName: 'get_server_health',
    }] : [],
    tierMap: withUnity ? [['ext_unity__get_server_health', 'unity']] : [],
    states: [['unity', withUnity
      ? { state: 'connected' }
      : { state: 'error', error: 'ECONNREFUSED' }]],
    customTierSummary: withUnity ? [['unity', { displayName: 'Unity', toolCount: 1 }]] : [],
    enabledServers: [{ id: 'unity', name: 'Unity', default_tier: 'unity' }],
    connectedCount: withUnity ? 1 : 0,
  };
}

describe('RemoteMcpServerManager catalogue refresh', () => {
  it('re-fetches a reconciled snapshot for a session that started before Unity', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(snapshot(false))
      .mockResolvedValueOnce(snapshot(true));
    const manager = new RemoteMcpServerManager({ request } as unknown as MessageBridge);

    await manager.connectAll([]);
    expect((await manager.listAllTools()).tools).toEqual([]);

    await manager.refreshAll([]);
    expect((await manager.listAllTools()).tools.map((tool) => tool.name)).toEqual([
      'ext_unity__get_server_health',
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      2,
      'mcpExt.snapshot',
      {},
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });
});
