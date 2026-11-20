import { describe, expect, it, vi } from 'vitest';
import { buildDocSearchBackend } from '../search-backend.js';

describe('host documentation search backend', () => {
  it.each([[undefined, false], ['0', false], ['1', true]] as const)('uses the optional reranker for flag %s', async (value, enabled) => {
    const search = vi.fn().mockResolvedValue({ results: [], diag: {} });
    vi.stubEnv('DOCS_RAG_RERANK', value);
    try {
      const backend = buildDocSearchBackend({ docHybridSearch: { search } as never, docStore: {} as never });
      await backend.search({ query: 'flush', scope: 'all' });
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ enhancements: expect.objectContaining({ rerank: enabled }) }));
    } finally { vi.unstubAllEnvs(); }
  });
  it('keeps the project boundary on catalog failure and forwards cancellation on success', async () => {
    const search = vi.fn().mockResolvedValue({ results: [], diag: {} });
    const listCollectionsForProject = vi.fn().mockImplementationOnce(() => { throw new Error('busy'); })
      .mockReturnValue([{ id: 17, name: 'project-manual' }]);
    const backend = buildDocSearchBackend({ docHybridSearch: { search } as never,
      docStore: { listCollectionsForProject } as never });
    const signal = new AbortController().signal;
    const query = { query: 'flush', scope: 'project' as const, project_id: 7 };
    await expect(backend.search(query, signal)).rejects.toThrow(/scope/i);
    expect(search).not.toHaveBeenCalled();
    await backend.search(query, signal);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ collection_ids: [17], signal }));
  });

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
