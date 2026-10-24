import { afterEach, expect, it, vi } from 'vitest';
import { McpAgentRunManager } from '../agent-run-manager.js';
import type { ToolContext } from '../context.js';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';

const id = 'read-fixture';
const ctx = { config: { dashboard: { port: 7333 } } } as ToolContext;
const row = (overrides = {}) => ({ id, project_id: 7, status: 'idle', metadata: {
  mcp_agent_run: { schema_version: 1, principal: 'reader', profile_id: 'p1', agent_id: 'coder', task_preview: 'task' },
}, ...overrides });
const auth = { principal: 'reader', policy: { id: 'p1', projectIds: [7], agentAllowlist: ['coder'] } } as unknown as AuthContext;
afterEach(() => { vi.unstubAllGlobals(); });

it('propagates body cancellation and leaves the next shared-manager request usable', async () => {
  const controller = new AbortController(); const cancelled = vi.fn();
  let fetched = false;
  const fetch = vi.fn(async () => {
    fetched = true;
    return new Response(new ReadableStream({ cancel: cancelled }));
  });
  vi.stubGlobal('fetch', fetch);
  const manager = new McpAgentRunManager(ctx);
  const reading = manager.get(id, auth, controller.signal);
  const failed = expect(reading).rejects.toThrow('stop read');
  await vi.waitFor(() => expect(fetched).toBe(true));
  controller.abort(new Error('stop read')); await failed;
  expect(cancelled).toHaveBeenCalledOnce();
  fetch.mockImplementation(async () => Response.json(row()));
  expect((await manager.get(id, auth)).id).toBe(id);
});

it('bounds body bytes and cancels an oversized response before JSON allocation', async () => {
  const cancelled = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }),
    { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } })));
  await expect(new McpAgentRunManager(ctx).get(id, auth)).rejects.toThrow('exceeds');
  expect(cancelled).toHaveBeenCalledOnce();
});

it.each(['../providers', 'x?full=1', '', 'a'.repeat(129)])('rejects invalid path identity %s before HTTP', async runId => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(new McpAgentRunManager(ctx).get(runId, auth)).rejects.toThrow('Invalid agent run id');
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects a server response for another run rather than returning its contents', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(row({ id: 'other' }))));
  await expect(new McpAgentRunManager(ctx).get(id, auth)).rejects.toThrow('divergent identity');
});

it.each([
  { id: 'p2', projectIds: [7], agentAllowlist: ['coder'] },
  { id: 'p1', projectIds: [8], agentAllowlist: ['coder'] },
  { id: 'p1', projectIds: [7], agentAllowlist: ['other'] },
])('enforces the connection profile for reads and cancellation', async policy => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(row())); vi.stubGlobal('fetch', fetch);
  const manager = new McpAgentRunManager(ctx);
  const denied = { ...auth, policy: { ...auth.policy!, ...policy } };
  await expect(manager.get(id, denied)).rejects.toThrow('outside this connection profile');
  await expect(manager.cancel(id, denied)).rejects.toThrow('outside this connection profile');
  expect(fetch.mock.calls.every(([url, init]) => !url.endsWith('/abort') && init?.method !== 'POST')).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('lists only the permitted profile and does not hydrate unauthorized rows', async () => {
  const fetch = vi.fn(async () => Response.json({ items: [row({ project_id: 8 })] })); vi.stubGlobal('fetch', fetch);
  expect(await new McpAgentRunManager(ctx).list(auth, 5)).toEqual([]);
  expect(fetch).toHaveBeenCalledOnce();
});

it('runs both catalog reads concurrently and cancels its sibling when one fails', async () => {
  const cancelled = vi.fn(); let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls++;
    if (url.endsWith('/agents')) return Response.json({ error: 'unavailable' }, { status: 503 });
    return new Response(new ReadableStream({ cancel: cancelled }));
  }));
  await expect(new McpAgentRunManager(ctx).catalog()).rejects.toThrow('unavailable');
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce()); expect(calls).toBe(2);
});

it('does not turn cancellation of list hydration into an interrupted successful result', async () => {
  const controller = new AbortController(); const cancelled = vi.fn(); let details = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/mcp-runs?')) return Response.json({ items: [row()] });
    details++; return new Response(new ReadableStream({ cancel: cancelled }));
  }));
  const result = new McpAgentRunManager(ctx).list(auth, 5, controller.signal);
  const failed = expect(result).rejects.toThrow('list cancelled');
  await vi.waitFor(() => expect(details).toBe(1)); controller.abort(new Error('list cancelled'));
  await failed; expect(cancelled).toHaveBeenCalledOnce();
});
