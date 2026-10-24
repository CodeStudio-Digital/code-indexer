import { expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { listMcpResourcePage, readMcpResource } from '../mcp-resource-bridge.js';
import { buildMcpResourceTools } from '../mcp-resources.js';
import type { McpToolBridge } from '../mcp-bridge.js';
import type { ToolContext } from '../../core/tool.js';

const client = (overrides = {}) => ({
  listResources: vi.fn(async () => ({ resources: [{ uri: 'mcp://one', name: 'one' }], nextCursor: 'opaque-page-2' })),
  listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  readResource: vi.fn(async () => ({ contents: [{ uri: 'mcp://one', text: 'complete text', mimeType: 'text/plain' }] })),
  ...overrides,
});
const cast = (value: unknown) => value as Client;

it('preserves opaque cursors, reads one protocol page, and renders continuation calls', async () => {
  const rpc = client(); const page = await listMcpResourcePage(cast(rpc));
  expect(page.nextResourceCursor).toBe('opaque-page-2'); expect(rpc.listResources).toHaveBeenCalledTimes(1);
  await listMcpResourcePage(cast(rpc), { kind: 'resources', cursor: page.nextResourceCursor });
  expect(rpc.listResources).toHaveBeenLastCalledWith({ cursor: 'opaque-page-2' }, expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 10000 }));
  expect(rpc.listResourceTemplates).toHaveBeenCalledTimes(1);
  const [tool] = buildMcpResourceTools({ listResources: async () => page } as unknown as McpToolBridge);
  const result = await tool.handler({}, {} as ToolContext); expect(result.content).toContain('"cursor":"opaque-page-2"');
});

it('treats only MethodNotFound as unsupported, never timeout or cancellation', async () => {
  const unsupported = Object.assign(new Error('unsupported'), { code: -32601 });
  const rpc = client({ listResources: vi.fn(async () => { throw unsupported; }) });
  expect((await listMcpResourcePage(cast(rpc))).resources).toEqual([]);
  rpc.listResources.mockRejectedValueOnce(new Error('transport disconnected'));
  await expect(listMcpResourcePage(cast(rpc))).rejects.toThrow('transport disconnected');
  const ctrl = new AbortController(); ctrl.abort(new Error('cancelled'));
  rpc.listResources.mockClear(); await expect(listMcpResourcePage(cast(rpc), { signal: ctrl.signal })).rejects.toThrow('cancelled');
  expect(rpc.listResources).not.toHaveBeenCalled();
});

it('settles both outstanding list requests before reporting an error', async () => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => { release = resolve; });
  const rpc = client({ listResources: async () => { throw new Error('failed resource listing'); }, listResourceTemplates: async () => { await deferred; return { resourceTemplates: [] }; } });
  let settled = false; const result = listMcpResourcePage(cast(rpc)).catch(error => { settled = true; return error; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
  release(); expect((await result).message).toContain('failed resource listing');
});

it('passes live cancellation to SDK reads and refuses late results', async () => {
  const ctrl = new AbortController(); let seen: AbortSignal | undefined;
  const rpc = client({ readResource: async (_: unknown, options: { signal: AbortSignal }) => { seen = options.signal; ctrl.abort(new Error('owner stopped')); return { contents: [{ uri: 'mcp://one', text: 'late' }] }; } });
  await expect(readMcpResource(cast(rpc), 'mcp://one', ctrl.signal)).rejects.toThrow('owner stopped'); expect(seen?.aborted).toBe(true);
});

it('bounds resource bodies and metadata without silently losing text or catalog entries', async () => {
  const rpc = client({ readResource: async () => ({ contents: [{ uri: 'x', text: 'x'.repeat(8 * 1024 * 1024 + 1) }] }) });
  await expect(readMcpResource(cast(rpc), 'x')).rejects.toThrow('8 MiB');
  const huge = client({ listResources: async () => ({ resources: Array.from({ length: 1001 }, () => ({ uri: 'x', name: 'x' })) }) });
  await expect(listMcpResourcePage(cast(huge))).rejects.toThrow('must paginate');
  expect(await readMcpResource(cast(client()), 'mcp://one')).toEqual({ contents: 'complete text', mimeType: 'text/plain' });
});
