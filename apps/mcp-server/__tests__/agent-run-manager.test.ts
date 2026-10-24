import { afterEach, expect, it, vi } from 'vitest';
import { McpAgentRunManager } from '../agent-run-manager.js';
import type { ToolContext } from '../context.js';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';

afterEach(() => { vi.unstubAllGlobals(); });
const id = '11111111-1111-4111-8111-111111111111';
const input = { projectName: 'fixture', task: 'Read the file', agentId: 'coder', provider: 'fixture', model: 'local' };
const ctx = { config: { dashboard: { port: 7333 } }, db: { listProjects: () => [{ id: 7, name: 'fixture' }] } } as unknown as ToolContext;
function fixture(options: { stream?: string; abortStatus?: number; restoredStatus?: string; discover?: boolean; cancelStream?: string;
  activeIds?: string[]; listFailure?: boolean } = {}) {
  let metadata: unknown = { mcp_agent_run: { schema_version: 1, principal: 'local-dev', profile_id: null, agent_id: 'coder', task_preview: 'task' } };
  let submissions = 0;
  const detailPaths: string[] = [];
  const finalText = 'answer '.repeat(3_000).trim();
  const fetch = vi.fn(async (address: string, init?: RequestInit) => {
    const url = new URL(address);
    if (url.pathname === '/api/coder/mcp-runs') {
      if (options.listFailure) return Response.json({ error: 'catalog unavailable' }, { status: 503 });
      return Response.json({ active_ids: options.activeIds ?? [], items: options.discover
        ? [{ id, project_id: 7, status: 'idle', metadata }] : [] });
    }
    if (url.pathname.endsWith('/abort')) return Response.json({ ok: options.abortStatus !== 503 }, { status: options.abortStatus ?? 200 });
    if (url.pathname.endsWith('/attach')) return new Response(options.cancelStream ?? 'event: done\ndata: {"reason":"aborted"}\n\n');
    if (url.pathname.endsWith('/messages')) {
      submissions++;
      return options.stream === undefined ? new Response(new ReadableStream())
        : new Response(options.stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname === '/api/coder/sessions' && init?.method === 'POST') {
      metadata = JSON.parse(String(init.body)).metadata;
      return Response.json({ id, project_id: 7, status: 'idle', metadata });
    }
    if (url.pathname === '/api/coder/sessions') return Response.json(options.discover ? [{ id, project_id: 7, status: 'idle', metadata }] : []);
    detailPaths.push(url.search);
    return Response.json({ session: { id, project_id: 7, status: 'idle', metadata },
      ...(options.restoredStatus ? { runtime_outcome: { runtimeGeneration: 'rust_v1', status: options.restoredStatus,
        agentRunId: 'run', attemptId: 'attempt', reason: 'durable_terminal' } } : {}),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: finalText }] }] });
  });
  vi.stubGlobal('fetch', fetch);
  return { manager: new McpAgentRunManager(ctx), fetch, detailPaths, finalText, submissions: () => submissions };
}

it.each([
  ['done', 'completed', 'completed'], ['done', 'max_turns', 'interrupted'],
  ['done', 'aborted', 'cancelled'], ['error', 'native_provider_failed', 'failed'],
])('keeps the durable %s/%s classification as %s', async (event, reason, status) => {
  const f = fixture({ stream: `event: text\ndata: {"text":"partial"}\n\nevent: ${event}\ndata: ${JSON.stringify({ reason })}\n\n` });
  expect((await f.manager.start(input)).id).toBe(id);
  await vi.waitFor(async () => expect((await f.manager.get(id)).status).toBe(status));
  const run = await f.manager.get(id);
  expect(run.finalText).toBe(f.finalText);
  expect(run.error).toBe(status === 'failed' ? reason : null);
  expect(f.detailPaths).toEqual(['?tail=60&full=1']);
  expect(f.submissions()).toBe(1);
});

it('does not declare completion or resubmit after EOF without a terminal receipt', async () => {
  const f = fixture({ stream: 'event: text\ndata: {"text":"uncertain partial"}\n\n' });
  await f.manager.start(input);
  await vi.waitFor(async () => expect((await f.manager.get(id)).status).toBe('interrupted'));
  expect((await f.manager.get(id)).error).toContain('without a terminal receipt');
  expect(f.submissions()).toBe(1);
});

it.each([200, 503])('reports cancellation acknowledgement honestly for HTTP %i', async abortStatus => {
  const f = fixture({ abortStatus });
  await f.manager.start(input);
  await vi.waitFor(() => expect(f.submissions()).toBe(1));
  const cancelled = await f.manager.cancel(id);
  expect(cancelled.status).toBe(abortStatus === 200 ? 'cancelled' : 'interrupted');
  expect(cancelled.error === null).toBe(abortStatus === 200);
  expect((await f.manager.get(id)).status).toBe(cancelled.status);
});

it('loads an untrimmed final result after manager restart and preserves principal isolation', async () => {
  const f = fixture();
  const restored = await f.manager.get(id);
  expect(restored.finalText).toBe(f.finalText);
  expect(f.detailPaths[0]).toBe('?tail=60&full=1');
  await expect(f.manager.get(id, { principal: 'another-client' } as AuthContext)).rejects.toThrow('another principal');
});

it('does not claim cancellation from the ACK when the terminal receipt is missing', async () => {
  const f = fixture({ cancelStream: '' });
  await f.manager.start(input);
  const result = await f.manager.cancel(id);
  expect(result.status).toBe('interrupted');
  expect(result.error).toContain('outcome was not confirmed');
});

it('preserves actual completion if it wins the cancellation race', async () => {
  const f = fixture({ cancelStream: 'event: done\ndata: {"reason":"completed"}\n\n' });
  await f.manager.start(input);
  expect((await f.manager.cancel(id)).status).toBe('completed');
});

it('serializes starts sharing a concurrency quota across asynchronous session creation', async () => {
  const f = fixture();
  const auth = { principal: 'local-dev', policy: { id: null, agentAllowlist: [], maxConcurrentRuns: 1 } } as unknown as AuthContext;
  const results = await Promise.allSettled([f.manager.start(input, auth), f.manager.start(input, auth)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message).toContain('Concurrent agent-run limit');
  expect(f.submissions()).toBe(1);
  await f.manager.cancel(id);
  await expect(f.manager.start(input, auth)).resolves.toMatchObject({ status: 'running' });
  await f.manager.cancel(id);
});

it('counts active ownership independently of recent history and does not hydrate transcripts during admission', async () => {
  const f = fixture({ activeIds: ['old-active-one', 'old-active-two'] });
  await expect(f.manager.start(input)).rejects.toThrow('Concurrent agent-run limit');
  expect(f.detailPaths).toEqual([]); expect(f.submissions()).toBe(0);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const query = new URL(f.fetch.mock.calls[0]![0]);
  expect(query.pathname).toBe('/api/coder/mcp-runs');
  expect(query.searchParams.get('mode')).toBe('active');
});

it('fails admission closed when active ownership cannot be queried', async () => {
  const f = fixture({ listFailure: true });
  await expect(f.manager.start(input)).rejects.toThrow('catalog unavailable');
  expect(f.submissions()).toBe(0);
});

it('requests one bounded metadata page instead of complete project session lists', async () => {
  const f = fixture();
  expect(await f.manager.list(undefined, 3)).toEqual([]);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const query = new URL(f.fetch.mock.calls[0]![0]);
  expect(query.pathname).toBe('/api/coder/mcp-runs');
  expect(query.searchParams.get('limit')).toBe('3');
});

it.each(['completed', 'failed', 'cancelled', 'interrupted', 'running'])('restores durable native %s instead of inferring success from partial text', async status => {
  const f = fixture({ restoredStatus: status, discover: true });
  expect((await f.manager.get(id)).status).toBe(status);
  const runs = await f.manager.list();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe(status);
  if (status === 'failed') expect(runs[0]!.error).toBe('durable_terminal');
});
