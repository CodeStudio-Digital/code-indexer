import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupProjectUnusedVectors,
  codeNamespaceStatus,
  fetchProjectSemanticStatus,
  requestProjectSemanticReindex,
  recordProjectSemanticOutcome,
  semanticCoveragePercent,
  semanticWorkIsActive,
  testProjectSemanticSearch,
  type ProjectSemanticStatus,
} from '../project-semantic-api.js';

function status(overrides: Partial<ProjectSemanticStatus> = {}): ProjectSemanticStatus {
  return {
    project_id: 91,
    profiles: [{ purpose: 'code', embedding_target: { kind: 'onnx' } }],
    namespaces: [{
      namespace: 'code:p91',
      active: null,
      building: null,
      expected_items: 10,
      indexed_items: 4,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    }],
    reindex_job: null,
    ...overrides,
  };
}

describe('project semantic API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opening the surface only reads status and never starts indexing', async () => {
    const payload = status();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProjectSemanticStatus(91)).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/91/semantic/status');
  });

  it('starts only the selected project after an explicit action', async () => {
    const job = {
      id: 12,
      status: 'pending' as const,
      expected_items: 10,
      processed_items: 0,
      failed_items: 0,
      error: null,
      updated_at: '2026-07-15 10:00:00',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, job }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestProjectSemanticReindex(91, 'start')).resolves.toEqual(job);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/91/semantic/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
  });

  it('cleans unused vectors only in the selected project', async () => {
    const result = {
      tables_removed: 1,
      items_removed: 20,
      databases_compacted: 1,
      bytes_reclaimed: 4096,
      skipped_referenced: 1,
      failures: [],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupProjectUnusedVectors(91)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/91/semantic/vectors/cleanup-unused',
      { method: 'POST' },
    );
  });

  it('runs a fresh project search through the production semantic route', async () => {
    const payload = {
      results: [],
      diagnostics: {
        vectorAvailable: true,
        embeddingAvailable: true,
        effectiveMode: 'hybrid',
        rerankerApplied: true,
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(testProjectSemanticSearch(91, {
      query: 'onde a sessão do agente é retomada',
      mode: 'hybrid',
      type: 'all',
      limit: 10,
    }, controller.signal)).resolves.toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'http://localhost');
    expect(parsed.pathname).toBe('/api/projects/91/search');
    expect(Object.fromEntries(parsed.searchParams.entries())).toEqual({
      q: 'onde a sessão do agente é retomada',
      mode: 'hybrid',
      type: 'all',
      limit: '10',
      supersessionKey: 'semantic-test:p91',
      bypassCache: '1',
      consumer: 'semantic_test',
    });
    expect(init).toEqual({ signal: controller.signal });
  });

  it('records a useful semantic result without sending query or path content', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(recordProjectSemanticOutcome(91, 'request-91', true)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/91/search/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'request-91', semanticWin: true }),
    });
  });

  it('treats only a running job as active work', () => {
    expect(semanticWorkIsActive(status())).toBe(false);
    expect(semanticWorkIsActive(status({
      namespaces: [{
        ...status().namespaces[0],
        building: { generationId: 2 },
      }],
      reindex_job: null,
    }))).toBe(false);
    expect(semanticWorkIsActive(status({
      reindex_job: {
        id: 12,
        status: 'pending',
        expected_items: 10,
        processed_items: 0,
        failed_items: 0,
        error: null,
        updated_at: 'now',
      },
    }))).toBe(false);
    expect(semanticWorkIsActive(status({
      reindex_job: {
        id: 13,
        status: 'running',
        expected_items: 10,
        processed_items: 2,
        failed_items: 0,
        error: null,
        updated_at: 'now',
      },
    }))).toBe(true);
    expect(semanticWorkIsActive(status({
      namespaces: [{
        ...status().namespaces[0],
        building: { generationId: 2 },
      }],
      reindex_job: {
        id: 12,
        status: 'paused',
        expected_items: 10,
        processed_items: 4,
        failed_items: 1,
        error: 'interrupted by restart',
        updated_at: 'now',
      },
    }))).toBe(false);
    expect(semanticWorkIsActive(status({
      reindex_job: {
        id: 12,
        status: 'completed',
        expected_items: 10,
        processed_items: 10,
        failed_items: 0,
        error: null,
        updated_at: 'now',
      },
    }))).toBe(false);
  });

  it('derives code coverage only from the project namespace', () => {
    const current = status();
    expect(codeNamespaceStatus(current)?.namespace).toBe('code:p91');
    expect(semanticCoveragePercent(codeNamespaceStatus(current))).toBe(40);
  });
});
