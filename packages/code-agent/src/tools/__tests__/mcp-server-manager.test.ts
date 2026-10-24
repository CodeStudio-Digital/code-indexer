import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { McpServerManager } from '../mcp-server-manager.js';
import type { ToolContext } from '../../core/tool.js';

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
  it.each(['ECONNRESET after commit', 'HTTP 401 after commit', 'socket hang up'])('never replays a dispatched mutation after %s', async (failure) => {
    let effects = 0;
    const callTool = vi.fn(async () => { effects++; throw new Error(failure); });
    const manager = new McpServerManager();
    const internal = manager as unknown as { connections: Map<string, unknown>; reconnectServer: () => Promise<void> };
    internal.connections.set('unity', { state: 'connected', config: { ...serverConfig(), auth_type: 'oauth2' },
      client: { callTool, listTools: async () => ({ tools: [{ name: 'write', inputSchema: { type: 'object' } }] }) } });
    const reconnect = vi.spyOn(internal, 'reconnectServer');
    const { tools } = await manager.listAllTools();
    const result = await tools[0].handler({}, {} as ToolContext);
    expect(result).toMatchObject({ effectOutcome: 'unknown', isError: true, error: { retryable: false } });
    expect(effects).toBe(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('passes cancellation into the SDK and does not send a pre-cancelled call', async () => {
    const controller = new AbortController();
    const callTool = vi.fn(async (_request, _schema, options) => {
      expect(options.signal).toBe(controller.signal);
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const manager = new McpServerManager();
    (manager as unknown as { connections: Map<string, unknown> }).connections.set('unity', {
      state: 'connected', config: serverConfig(), client: { callTool,
        listTools: async () => ({ tools: [{ name: 'write', inputSchema: { type: 'object' } }] }) },
    });
    const { tools } = await manager.listAllTools();
    await tools[0].handler({}, { signal: controller.signal } as ToolContext);
    controller.abort();
    expect(await tools[0].handler({}, { signal: controller.signal } as ToolContext)).toMatchObject({ isError: true });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
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
          annotations: { readOnlyHint: true },
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
      expect(first.tools.find((tool) => tool.name === 'ext_unity__read_scene')).toMatchObject({
        mutates: true,
        parallelSafe: false,
        riskLevel: 'write',
      });
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

  it('preserves structured data and multimodal MCP result blocks', async () => {
    const manager = new McpServerManager();
    const callTool = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'captured game view' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
        {
          type: 'resource',
          resource: {
            uri: 'unity://report.json',
            mimeType: 'application/json',
            text: '{"fps":60}',
          },
        },
      ],
      structuredContent: { width: 1280, height: 720 },
      isError: false,
    });
    (manager as unknown as {
      connections: Map<string, unknown>;
    }).connections.set('unity', {
      client: { callTool },
      config: serverConfig(),
      state: 'connected',
    });

    const result = await manager.callServerTool('unity', 'screenshot_game_view', {});

    expect(result.content).toBe('captured game view');
    expect(result.structuredData).toEqual({ width: 1280, height: 720 });
    expect(result.extraUserBlocks).toEqual([
      { type: 'image', mediaType: 'image/png', base64: 'aW1hZ2U=' },
      {
        type: 'document',
        name: 'unity://report.json',
        mediaType: 'application/json',
        text: '{"fps":60}',
        base64: undefined,
      },
    ]);
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
