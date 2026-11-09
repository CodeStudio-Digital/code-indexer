import { describe, expect, it, vi } from 'vitest';
import { listToolsFromConnection } from '../mcp-catalog-listing.js';
import type { ServerConnection } from '../mcp-connection-types.js';
const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } });

describe('bounded MCP catalogue', () => {
  it('walks pages and deduplicates identical definitions', async () => {
    const listTools = vi.fn().mockResolvedValueOnce({ tools: [tool('b')], nextCursor: 'second' })
      .mockResolvedValueOnce({ tools: [tool('a'), tool('b')] });
    const result = await listToolsFromConnection('s', { client: { listTools } } as unknown as ServerConnection);
    expect(result.map(t => t.name)).toEqual(['a', 'b']);
    expect(listTools.mock.calls[1]![0]).toEqual({ cursor: 'second' });
  });
  it('rejects repeated cursors instead of publishing an incomplete catalogue', async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [], nextCursor: 'loop' });
    await expect(listToolsFromConnection('s', { client: { listTools } } as unknown as ServerConnection)).rejects.toThrow('repeated');
    expect(listTools).toHaveBeenCalledTimes(2);
  });
  it('never dispatches after cancellation', async () => {
    const listTools = vi.fn(); const c = new AbortController(); c.abort();
    await expect(listToolsFromConnection('s', { client: { listTools } } as unknown as ServerConnection, { signal: c.signal })).rejects.toThrow();
    expect(listTools).not.toHaveBeenCalled();
  });
  it('bounds page acquisition and refuses conflicting definitions', async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [], nextCursor: 'more' });
    await expect(listToolsFromConnection('s', { client: { listTools } } as unknown as ServerConnection, { maxPages: 1 })).rejects.toThrow('pagination budget');
    listTools.mockReset().mockResolvedValueOnce({ tools: [tool('a')], nextCursor: 'b' })
      .mockResolvedValueOnce({ tools: [{ ...tool('a'), description: 'changed' }] });
    await expect(listToolsFromConnection('s', { client: { listTools } } as unknown as ServerConnection)).rejects.toThrow('changed');
  });
});
