import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { McpServerManager } from '../mcp-server-manager.js';

function serverConfig(id = 'unity'): McpServerConfig {
  return {
    id,
    name: 'Unity Editor',
    transport: 'streamable_http',
    enabled: true,
    url: 'http://127.0.0.1:8765/mcp/',
    command: null,
    args: [],
    env: {},
    auth_type: 'none',
    auth_token: null,
    default_tier: 'unity',
    config: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('McpServerManager tool catalogue isolation', () => {
  it('keeps valid tools when one sibling has an invalid input schema', async () => {
    const schemaError = Object.assign(new Error('Invalid input: expected "object"'), {
      issues: [{
        path: ['tools', 1, 'inputSchema', 'type'],
        message: 'Invalid input: expected "object"',
      }],
    });
    const listTools = vi.fn().mockRejectedValue(schemaError);
    const request = vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'read_scene',
          description: 'Read the active scene.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'broken_tool',
          description: 'Malformed server definition.',
          inputSchema: { type: 'string' },
        },
        {
          name: 'create_empty',
          description: 'Create a GameObject.',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      ],
    });

    const manager = new McpServerManager();
    (manager as unknown as {
      connections: Map<string, unknown>;
    }).connections.set('unity', {
      client: { listTools, request },
      config: serverConfig(),
      state: 'connected',
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = await manager.listAllTools();
      expect(first.tools.map((tool) => tool.name)).toEqual([
        'ext_unity__create_empty',
        'ext_unity__read_scene',
      ]);
      expect(manager.connectedCount).toBe(1);
      expect(request).toHaveBeenCalledWith(
        { method: 'tools/list' },
        expect.anything(),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped 1 invalid tool definition(s): broken_tool'),
      );

      await manager.listAllTools();
      expect(listTools).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('still marks the server unhealthy for non-schema list failures', async () => {
    const manager = new McpServerManager();
    (manager as unknown as {
      connections: Map<string, unknown>;
    }).connections.set('unity', {
      client: {
        listTools: vi.fn().mockRejectedValue(new Error('connection reset')),
      },
      config: serverConfig(),
      state: 'connected',
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await manager.listAllTools();
      expect(result.tools).toEqual([]);
      expect(manager.connectedCount).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
