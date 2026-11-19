import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectIndexService } from '../service.js';
import type { StructuralExecutor } from '../types.js';

const services: ProjectIndexService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.dispose())); });
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() };
};
function fixture(options: { gates?: ReturnType<typeof deferred>[]; failure?: 'too_large' | 'error'; autoIndex?: boolean; flushGate?: ReturnType<typeof deferred> } = {}) {
  const gates = options.gates ?? [deferred()];
  let completed = 0;
  let started = 0;
  const executor = {
    runStructuralIndex: vi.fn(async (_id: number, _opts: Parameters<StructuralExecutor['runStructuralIndex']>[1]) => {
      const gate = gates[started++];
      await gate?.promise;
      if (options.failure === 'error') throw new Error('write failed');
      completed++;
      return { totalFiles: 2, indexed: 2, removed: 0, skipped: 0, errorCount: 0, durationMs: 1,
        ...(options.failure === 'too_large' ? { aborted: 'too_large' as const } : {}) };
    }),
    indexFiles: vi.fn(async () => ({ indexed: 0, skippedUnchanged: 0, skippedIgnored: 0, removed: 0, errors: 0 })),
    removeFiles: vi.fn(async () => ({ removed: 0 })),
  } satisfies StructuralExecutor;
  const project = { id: 1, root_path: 'D:/fake', file_count: 2, symbol_count: 3,
    structural_indexed_at: '2026-01-01T00:00:00Z', last_indexed: null };
  const db = { getProjectCatalogEntry: () => project, getProject: () => project, countSemanticStale: () => 1 };
  const watcher = { startWatching() {}, async waitUntilReady() {}, async flushPending() { await options.flushGate?.promise; },
    async stopWatching() {}, async stopAll() {}, isWatching: () => Boolean(options.flushGate) };
  const svc = new ProjectIndexService(db as never, executor, watcher as never, () => ({
    autoIndex: options.autoIndex ?? true, autoWatch: false, maxFiles: 20000, maxWatchedProjects: 3,
    watchDebounceMs: 50, watchOpenDelayMs: 0, watchIdleMs: 0, watchMaxFiles: 0, openDelayMs: 0,
  }), watcher as never);
  services.push(svc);
  return { svc, executor, gates, completed: () => completed };
}

describe('explicit structural reconciliation', () => {
  it('keeps baseline readiness fast but awaits the requested repair pass', async () => {
    const h = fixture({ autoIndex: false });
    await expect(h.svc.ensureStructuralReady(1, 100)).resolves.toMatchObject({ status: 'ready' });
    const settled = vi.fn();
    const requested = h.svc.reconcileStructural(1, 1000).then(value => { settled(value); return value; });
    await vi.waitFor(() => expect(h.executor.runStructuralIndex).toHaveBeenCalledTimes(1));
    expect(settled).not.toHaveBeenCalled();
    expect(h.completed()).toBe(0);
    expect(h.executor.runStructuralIndex.mock.calls[0][1]).toMatchObject({ forceReparse: true, allowEmptyWipe: true });
    h.gates[0].release();
    await expect(requested).resolves.toMatchObject({ status: 'ready', phase: 'structural_ready' });
    expect(h.completed()).toBe(1);
  });

  it('waits for an active pass, then performs its own repair instead of accepting the older pass', async () => {
    const h = fixture({ gates: [deferred(), deferred()] });
    h.svc.ensureFresh(1, 'open');
    await vi.waitFor(() => expect(h.executor.runStructuralIndex).toHaveBeenCalledTimes(1));
    const settled = vi.fn();
    const requested = h.svc.reconcileStructural(1, 1000).then(value => { settled(); return value; });
    h.gates[0].release();
    await vi.waitFor(() => expect(h.executor.runStructuralIndex).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    expect(h.executor.runStructuralIndex.mock.calls[1][1]).toMatchObject({ forceReparse: true });
    h.gates[1].release();
    await expect(requested).resolves.toMatchObject({ status: 'ready' });
  });

  it('does not report success before the watcher barrier is drained', async () => {
    const flushGate = deferred();
    const h = fixture({ flushGate });
    const settled = vi.fn();
    const requested = h.svc.reconcileStructural(1, 1000).then(value => { settled(); return value; });
    h.gates[0].release();
    await vi.waitFor(() => expect(h.completed()).toBe(1));
    expect(settled).not.toHaveBeenCalled();
    flushGate.release();
    await expect(requested).resolves.toMatchObject({ status: 'ready' });
  });

  it.each(['aborted', 'timeout'] as const)('does not execute a queued request after %s', async status => {
    const h = fixture();
    h.svc.ensureFresh(1, 'open');
    await vi.waitFor(() => expect(h.executor.runStructuralIndex).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const requested = h.svc.reconcileStructural(1, status === 'timeout' ? 5 : 1000, controller.signal);
    if (status === 'aborted') controller.abort();
    await expect(requested).resolves.toMatchObject({ status });
    h.gates[0].release();
    await vi.waitFor(() => expect(h.svc.getStatus(1).phase).toBe('structural_ready'));
    expect(h.executor.runStructuralIndex).toHaveBeenCalledTimes(1);
  });

  it.each(['too_large', 'error'] as const)('reports %s even if the old baseline was ready', async failure => {
    const h = fixture({ failure });
    const requested = h.svc.reconcileStructural(1, 1000);
    h.gates[0].release();
    await expect(requested).resolves.toMatchObject({ status: failure });
  });

  it('does not schedule an already cancelled request', async () => {
    const h = fixture();
    await expect(h.svc.reconcileStructural(1, 1000, AbortSignal.abort())).resolves.toMatchObject({ status: 'aborted' });
    expect(h.executor.runStructuralIndex).not.toHaveBeenCalled();
  });

  it('revalidates ownership after waiting and prevents a stale owner from starting repair', async () => {
    const h = fixture();
    h.svc.ensureFresh(1, 'open');
    await vi.waitFor(() => expect(h.executor.runStructuralIndex).toHaveBeenCalledTimes(1));
    const checkOwner = vi.fn(() => { throw new Error('lease lost'); });
    const requested = h.svc.reconcileStructural(1, 1000, undefined, checkOwner);
    expect(checkOwner).not.toHaveBeenCalled();
    h.gates[0].release();
    await expect(requested).resolves.toMatchObject({ status: 'error', error: 'lease lost' });
    expect(checkOwner).toHaveBeenCalledTimes(1);
    expect(h.executor.runStructuralIndex).toHaveBeenCalledTimes(1);
  });

  it('revalidates ownership after waiting on a semantic job that holds the shared mutex', async () => {
    const h = fixture();
    const semanticGate = deferred();
    const semantic = h.svc.withSemanticRun(1, () => semanticGate.promise);
    let leaseCurrent = true;
    const checkOwner = vi.fn(() => { if (!leaseCurrent) throw new Error('lease lost'); });
    const requested = h.svc.reconcileStructural(1, 1000, undefined, checkOwner);
    await new Promise(r => setTimeout(r, 5));
    expect(checkOwner).not.toHaveBeenCalled();
    leaseCurrent = false;
    semanticGate.release();
    await semantic;
    await expect(requested).resolves.toMatchObject({ status: 'error', error: 'lease lost' });
    expect(h.executor.runStructuralIndex).not.toHaveBeenCalled();
  });

  it.each(['aborted', 'timeout'] as const)('skips the worker after %s while waiting on the shared mutex', async status => {
    const h = fixture();
    const semanticGate = deferred();
    const semantic = h.svc.withSemanticRun(1, () => semanticGate.promise);
    const controller = new AbortController();
    const requested = h.svc.reconcileStructural(1, status === 'timeout' ? 5 : 1000, controller.signal);
    if (status === 'aborted') controller.abort();
    await expect(requested).resolves.toMatchObject({ status });
    semanticGate.release();
    await semantic;
    // Drain microtasks and the watcher barrier before checking non-execution.
    await new Promise(r => setTimeout(r, 10));
    expect(h.executor.runStructuralIndex).not.toHaveBeenCalled();
  });
});
