/**
 * Tests for I3 — files_updated event → HybridSearch cache invalidation.
 *
 * The IndexAgent listener wiring is tested via a stub IndexAgent-shape
 * (we just need `onFilesUpdated` registration + emit). The real
 * IndexAgent fires this after `indexProject` completes (see
 * `indexer.ts:14b`); covering THAT integration requires a full indexer
 * harness which is out of scope for this unit test.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeHybridSearchCacheInvalidator } from '../cache-invalidator.js';
import type { IndexerFilesUpdatedEvent, IndexerFilesUpdatedListener } from '../../indexer/indexer-events.js';
import type { HybridSearch } from '../hybrid.js';

function stubHybridSearch(): { mock: HybridSearch; invalidations: number } {
  let invalidations = 0;
  const mock = {
    invalidateCache(): void { invalidations++; },
  } as unknown as HybridSearch;
  return {
    mock,
    get invalidations() { return invalidations; },
  };
}

const event: IndexerFilesUpdatedEvent = {
  projectId: 1,
  projectName: 'proj',
  runId: 100,
  indexedCount: 5,
  removedCount: 1,
  status: 'completed',
  finishedAtMs: Date.now(),
};

describe('makeHybridSearchCacheInvalidator', () => {
  it('clears the cache on a completed run', () => {
    const stub = stubHybridSearch();
    const listener = makeHybridSearchCacheInvalidator(stub.mock);
    listener(event);
    expect(stub.invalidations).toBe(1);
  });

  it('clears the cache on a failed run too (config migration could still affect search)', () => {
    const stub = stubHybridSearch();
    const listener = makeHybridSearchCacheInvalidator(stub.mock);
    listener({ ...event, status: 'failed', indexedCount: 0, removedCount: 0 });
    expect(stub.invalidations).toBe(1);
  });

  it('clears once per event, not cumulatively per registration', () => {
    const stub = stubHybridSearch();
    const listener = makeHybridSearchCacheInvalidator(stub.mock);
    listener(event);
    listener(event);
    listener(event);
    expect(stub.invalidations).toBe(3);
  });

  it('returns a sync listener (no Promise leakage)', () => {
    const stub = stubHybridSearch();
    const listener: IndexerFilesUpdatedListener = makeHybridSearchCacheInvalidator(stub.mock);
    const result = listener(event);
    // Listener may return void or Promise per the type; the invalidator
    // is sync and should NOT return a Promise.
    expect(result).toBeUndefined();
  });
});

describe('IndexAgent listener integration (mocked)', () => {
  it('multiple listeners fire in registration order, one bad listener does not block others', async () => {
    // Mimic IndexAgent's onFilesUpdated registry without spinning up
    // the full agent (no DB, providers, etc).
    const listeners: IndexerFilesUpdatedListener[] = [];
    const onFilesUpdated = (l: IndexerFilesUpdatedListener): (() => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    };
    const emit = async (e: IndexerFilesUpdatedEvent): Promise<void> => {
      for (const l of listeners) {
        try { await l(e); } catch { /* swallow */ }
      }
    };

    const calls: string[] = [];
    onFilesUpdated(() => { calls.push('first'); });
    onFilesUpdated(() => { throw new Error('boom'); });
    onFilesUpdated(() => { calls.push('third'); });

    await emit(event);
    expect(calls).toEqual(['first', 'third']);
  });

  it('unsubscribe removes a listener', async () => {
    const listeners: IndexerFilesUpdatedListener[] = [];
    const onFilesUpdated = (l: IndexerFilesUpdatedListener): (() => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    };

    const spy = vi.fn();
    const unsubscribe = onFilesUpdated(spy);
    unsubscribe();

    for (const l of listeners) await l(event);
    expect(spy).not.toHaveBeenCalled();
  });
});
