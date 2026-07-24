import { describe, expect, it, vi } from 'vitest';
import { buildDocSearchBackend } from '../search-backend.js';

describe('host documentation search backend', () => {
  it('makes best-effort telemetry fail fast on the Electron connection', async () => {
    const recordDocSearchEvent = vi.fn();
    const withBusyTimeout = vi.fn((_timeoutMs: number, operation: () => unknown) => operation());
    const docStore = {
      listCollectionsForProject: vi.fn(() => []),
      getCollectionByName: vi.fn(() => null),
      recordDocSearchEvent,
      withBusyTimeout,
    };
    const result = {
      results: [],
      diag: {
        mode: 'fts',
        scope: 'all',
        fts_hits: 0,
        vector_hits: 0,
        stale_vector_hits: 0,
        vector_coverage: 0,
        top_relevance: null,
        no_good_match: true,
      },
    };
    const backend = buildDocSearchBackend({
      docHybridSearch: { search: vi.fn().mockResolvedValue(result) } as never,
      docStore: docStore as never,
    });

    await backend.search({ query: 'durable write queue', project_id: 7 });

    expect(withBusyTimeout).toHaveBeenCalledWith(0, expect.any(Function));
    expect(recordDocSearchEvent).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 7,
      scope: 'all',
      no_good_match: true,
      result_count: 0,
    }));
  });
});
