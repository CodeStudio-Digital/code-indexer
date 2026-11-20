import { MessageChannel } from 'node:worker_threads';
import { MessageBridge } from '@mcp/orchestrator-host';
import { afterEach, expect, it, vi } from 'vitest';
import { createFifoLimiter, MAX_AGENT_SEARCHES_IN_FLIGHT, registerWorkerIndexHandlers } from '../worker-index-handlers.js';
import type { IndexSearchService } from '../../server/index-search-service.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(service: Partial<IndexSearchService> | null, options: Parameters<typeof registerWorkerIndexHandlers>[3] = {}) {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const off = registerWorkerIndexHandlers(main, () => ({ ids: { sessionId: 'host-session' } }), () => service as IndexSearchService, options);
  cleanup.push(() => { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); });
  return { worker, off };
}
const search = (worker: MessageBridge, requestId: string, extra: Record<string, unknown> = {}) =>
  worker.request('indexProjectSearch', { requestId, projectId: 7, query: requestId, ...extra });
const untilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

it('passes the claimed ids as telemetry candidates and answers JSON text', async () => {
  const projectSearch = vi.fn(async (..._args: unknown[]) => ({ results: [], diagnostics: { vectorAvailable: true } }));
  const { worker } = fixture({ projectSearch });
  const text = await search(worker, 'r1', { mode: 'hybrid', limit: 3, consumer: 'agent', sessionId: 'forged', companySessionId: 'forged' });
  expect(JSON.parse(text as string)).toEqual({ results: [], diagnostics: { vectorAvailable: true } });
  expect(projectSearch).toHaveBeenCalledWith({ projectId: 7, query: 'r1', mode: 'hybrid', type: undefined, limit: 3, consumer: 'agent' },
    { sessionId: 'forged', companySessionId: 'forged' }, expect.any(AbortSignal));
  await search(worker, 'r2', { consumer: 'not-a-consumer' });
  expect(projectSearch.mock.calls[1][1]).toEqual({ sessionId: 'host-session' });
  expect(projectSearch.mock.calls[1][0]).toMatchObject({ consumer: 'api' });
});

it('rejects invalid packets and a host without the service', async () => {
  const projectSearch = vi.fn(async () => ({}));
  const { worker } = fixture({ projectSearch });
  await expect(search(worker, 'r1', { projectId: 0 })).rejects.toThrow('Invalid project id');
  await expect(worker.request('indexProjectSearch', { projectId: 7, query: 'q' })).rejects.toThrow('Invalid or saturated');
  expect(projectSearch).not.toHaveBeenCalled();
  const unwired = fixture(null);
  await expect(search(unwired.worker, 'r2')).rejects.toThrow('Index search is not wired into this host');
});

it('projects memory hits to ids and reports a missing project like the route', async () => {
  const memorySearch = vi.fn(async (projectId: number) => projectId === 7
    ? { status: 200 as const, results: [{ id: 3, score: 0.9, name: 'kept on the host' }] as never[] }
    : { status: 404 as const, error: 'Not found' });
  const { worker } = fixture({ memorySearch });
  const text = await worker.request('indexMemorySearch', { requestId: 'm1', projectId: 7, query: 'q', limit: 2 });
  expect(JSON.parse(text as string)).toEqual({ results: [{ id: 3, score: 0.9 }] });
  expect(memorySearch).toHaveBeenCalledWith(7, 'q', 2, expect.any(AbortSignal));
  await expect(worker.request('indexMemorySearch', { requestId: 'm2', projectId: 8, query: 'q' })).rejects.toThrow('Not found');
});

it('wakes a namespace through the same reconcile function', async () => {
  const reconcile = vi.fn((namespace: unknown) => namespace === 'memory:project:p7'
    ? { ok: true as const, namespace: 'memory:project:p7', scheduled: true as const, first_generation: false }
    : { ok: false as const, error: 'unsupported semantic namespace' });
  const { worker } = fixture({ reconcile });
  expect(await worker.request('indexSemanticReconcile', { namespace: 'memory:project:p7' }))
    .toEqual({ ok: true, namespace: 'memory:project:p7', scheduled: true, first_generation: false });
  await expect(worker.request('indexSemanticReconcile', { namespace: 'code:p7' })).rejects.toThrow('unsupported semantic namespace');
});

it(`admits at most ${MAX_AGENT_SEARCHES_IN_FLIGHT} agent searches in FIFO order; a cancelled waiter leaves the queue`, async () => {
  const limiter = createFifoLimiter(MAX_AGENT_SEARCHES_IN_FLIGHT);
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const projectSearch = vi.fn((input: { query: string }) => new Promise<unknown>((resolve) => {
    started.push(input.query);
    finish.set(input.query, () => resolve({ query: input.query }));
  }));
  const { worker } = fixture({ projectSearch }, { limiter });
  const calls = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'].map(id => search(worker, id));
  await vi.waitFor(() => expect(started).toEqual(['r0', 'r1', 'r2', 'r3']));
  expect(limiter.stats()).toEqual({ active: 4, queued: 2 });
  await worker.request('indexSearchCancel', { requestId: 'r4' });
  await expect(calls[4]).rejects.toThrow('Index search cancelled');
  expect(limiter.stats()).toEqual({ active: 4, queued: 1 });
  finish.get('r1')!();
  await vi.waitFor(() => expect(started).toEqual(['r0', 'r1', 'r2', 'r3', 'r5']));
  for (const id of ['r0', 'r2', 'r3', 'r5']) finish.get(id)!();
  expect(await Promise.all([calls[0], calls[1], calls[5]])).toEqual(['{"query":"r0"}', '{"query":"r1"}', '{"query":"r5"}']);
  expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
});

it('counts queue time in the deadline: a waiter that expires in the queue never runs', async () => {
  const limiter = createFifoLimiter(1);
  let unblock!: () => void;
  // The running search ignores its signal, so it keeps the only slot past every deadline.
  const projectSearch = vi.fn(() => new Promise<unknown>((resolve) => { unblock = () => resolve({}); }));
  const { worker } = fixture({ projectSearch }, { limiter, deadlineMs: 150 });
  const running = search(worker, 'r1');
  await vi.waitFor(() => expect(projectSearch).toHaveBeenCalledOnce());
  const waiting = search(worker, 'r2');
  await expect(waiting).rejects.toThrow();
  expect(limiter.stats()).toEqual({ active: 1, queued: 0 });
  unblock();
  await expect(running).rejects.toThrow();
  expect(projectSearch).toHaveBeenCalledOnce();
  expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
});

it('delivers a worker cancellation to the host search as an AbortSignal', async () => {
  let seen: AbortSignal | undefined;
  const projectSearch = vi.fn((_input: unknown, _ids: unknown, signal: AbortSignal) => { seen = signal; return untilAborted(signal); });
  const { worker } = fixture({ projectSearch });
  const pending = search(worker, 'r1');
  await vi.waitFor(() => expect(seen).toBeDefined());
  await worker.request('indexSearchCancel', { requestId: 'r1' });
  await expect(pending).rejects.toThrow('Index search cancelled');
  expect(seen!.aborted).toBe(true);
  expect((seen!.reason as Error).message).toBe('Index search cancelled');
});

it('aborts searches in flight when the registration closes', async () => {
  let seen: AbortSignal | undefined;
  const projectSearch = vi.fn((_input: unknown, _ids: unknown, signal: AbortSignal) => { seen = signal; return untilAborted(signal); });
  const { worker, off } = fixture({ projectSearch });
  void search(worker, 'r1').catch(() => undefined);
  await vi.waitFor(() => expect(seen).toBeDefined());
  off();
  expect(seen!.aborted).toBe(true);
});
