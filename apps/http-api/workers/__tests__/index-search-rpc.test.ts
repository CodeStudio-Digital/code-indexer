import { MessageChannel } from 'node:worker_threads';
import { MessageBridge } from '@mcp/orchestrator-host';
import { afterEach, expect, it, vi } from 'vitest';
import { registerWorkerIndexHandlers } from '../../sse/worker-index-handlers.js';
import type { IndexSearchService } from '../../server/index-search-service.js';
import { createRpcSemanticSearchClient, requestNamespaceReconcile } from '../index-search-rpc.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const DIAGNOSTICS = { vectorAvailable: true, embeddingAvailable: true, effectiveMode: 'hybrid' };

/** Worker client ↔ host handlers over a real MessageBridge pair. */
function fixture(service: Partial<IndexSearchService> | null, clientDeadlineMs?: number) {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const off = service === null ? () => undefined
    : registerWorkerIndexHandlers(main, () => ({ ids: { sessionId: 'host-session' } }), () => service as IndexSearchService);
  cleanup.push(() => { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); });
  return { worker, client: createRpcSemanticSearchClient(worker, { deadlineMs: clientDeadlineMs }) };
}
const untilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

it('returns the host answer as the loopback client would and sends the claimed session ids', async () => {
  const value = { results: [{ id: 4, type: 'file', score: 0.8, fts_rank: null, vector_score: 0.8, data: { path: 'a.ts' } }], diagnostics: DIAGNOSTICS };
  const projectSearch = vi.fn(async () => value);
  const { client } = fixture({ projectSearch });
  const reply = await client.searchProject(7, 'vector routing', { mode: 'hybrid', type: 'all', limit: 2, consumer: 'agent',
    sessionId: 'claimed', companySessionId: 'claimed' });
  expect(reply).toEqual({ ok: true, value, error: null });
  const [input, ids] = projectSearch.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
  expect(input).toEqual({ projectId: 7, query: 'vector routing', mode: 'hybrid', type: 'all', limit: 2, consumer: 'agent' });
  expect(ids).toEqual({ sessionId: 'claimed', companySessionId: 'claimed' });
});

it('answers memory searches with the ids projection', async () => {
  const memorySearch = vi.fn(async () => ({ status: 200 as const, results: [{ id: 3, score: 0.5 }] as never[] }));
  const { client } = fixture({ memorySearch });
  expect(await client.searchProjectMemory(7, 'tests', 5)).toEqual({ ok: true, value: { results: [{ id: 3, score: 0.5 }] }, error: null });
  expect(memorySearch).toHaveBeenCalledWith(7, 'tests', 5, expect.any(AbortSignal));
});

it('degrades like an unavailable owner on a host error, a missing handler or an invalid payload', async () => {
  const failing = fixture({ projectSearch: async () => { throw new Error('project not found'); } });
  expect(await failing.client.searchProject(7, 'q')).toEqual({ ok: false, value: null, error: 'project not found' });
  const unhandled = fixture(null);
  expect(await unhandled.client.searchProject(7, 'q'))
    .toEqual({ ok: false, value: null, error: "no handler registered for 'indexProjectSearch'" });
  const invalid = fixture({ projectSearch: async () => ({ results: 'x' }),
    memorySearch: async () => ({ status: 200 as const, results: [{ id: 0, score: 1 }] as never[] }) });
  expect(await invalid.client.searchProject(7, 'q'))
    .toEqual({ ok: false, value: null, error: 'semantic server returned an invalid search payload' });
  expect(await invalid.client.searchProjectMemory(7, 'q'))
    .toEqual({ ok: false, value: null, error: 'semantic server returned an invalid memory payload' });
});

it('times out with the loopback text and cancels the host search', async () => {
  let seen: AbortSignal | undefined;
  const { client } = fixture({ projectSearch: (_input, _ids, signal) => { seen = signal; return untilAborted(signal); } }, 120);
  expect(await client.searchProject(7, 'slow')).toEqual({ ok: false, value: null, error: 'Local server request timed out' });
  await vi.waitFor(() => expect(seen?.aborted).toBe(true));
});

it('rejects on caller abort mid-call and the host search sees the AbortSignal', async () => {
  let seen: AbortSignal | undefined;
  const { client } = fixture({ projectSearch: (_input, _ids, signal) => { seen = signal; return untilAborted(signal); } });
  const caller = new AbortController();
  const pending = client.searchProject(7, 'q', { signal: caller.signal });
  await vi.waitFor(() => expect(seen).toBeDefined());
  caller.abort(new Error('stopped by the agent'));
  await expect(pending).rejects.toThrow('stopped by the agent');
  await vi.waitFor(() => expect(seen!.aborted).toBe(true));
  expect((seen!.reason as Error).message).toBe('Index search cancelled');
});

it('refuses before dispatch when the caller is already cancelled', async () => {
  const projectSearch = vi.fn(async () => ({}));
  const { client } = fixture({ projectSearch });
  const caller = new AbortController(); caller.abort(new Error('gone'));
  await expect(client.searchProject(7, 'q', { signal: caller.signal })).rejects.toThrow('gone');
  expect(projectSearch).not.toHaveBeenCalled();
});

it('wakes the host namespace catch-up and never fails the memory write', async () => {
  const reconcile = vi.fn(() => ({ ok: true as const, namespace: 'memory:project:p7', scheduled: true as const, first_generation: true }));
  const wired = fixture({ reconcile });
  await expect(requestNamespaceReconcile(wired.worker, 'memory:project:p7')).resolves.toBeUndefined();
  expect(reconcile).toHaveBeenCalledWith('memory:project:p7');
  const unwired = fixture(null);
  await expect(requestNamespaceReconcile(unwired.worker, 'memory:project:p7')).resolves.toBeUndefined();
});
