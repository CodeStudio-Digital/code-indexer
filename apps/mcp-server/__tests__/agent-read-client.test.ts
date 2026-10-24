import { expect, it, vi } from 'vitest';
import { createAgentReadClient } from '../agent-read-client.js';

it('exposes only reads and uses the injected owner transport without TCP', async () => {
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ path });
  });
  const client = createAgentReadClient(9999, transport);
  expect(Object.keys(client).sort()).toEqual(['catalog', 'get', 'list']);
  expect(await client.catalog()).toEqual({
    agents: { path: '/api/coder/agents' }, providers: { path: '/api/coder/providers' },
  });
  expect(transport).toHaveBeenCalledTimes(2);
});
