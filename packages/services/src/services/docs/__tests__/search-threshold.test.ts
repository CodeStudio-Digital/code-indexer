/**
 * Coverage for DocHybridSearch relevance wiring (Fase 1):
 *   - the reranker's calibrated 0-1 score lands on result.relevance
 *     (relevance_source='rerank'), instead of the opaque RRF score;
 *   - min_relevance drops weak hits and sets diag.no_good_match when
 *     nothing clears the bar, while still reporting diag.top_relevance;
 *   - without a reranker the set is uncalibrated and passes through
 *     untouched (relevance_source='rrf', no_good_match=false).
 *
 * FTS-only path (embeddingService=vectorStore=null) keeps the fakes small.
 */
import { describe, it, expect, vi } from 'vitest';
import { DocHybridSearch } from '../search.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import type { Reranker } from '../reranker.js';

interface FakeChunk {
  id: number;
  collection_id: number;
  source_id: number;
  source_uri: string | null;
  heading_path: string | null;
  content: string;
  summary: string | null;
  concepts: string[];
}

function fakeChunks(): FakeChunk[] {
  return [
    { id: 1, collection_id: 1, source_id: 1, source_uri: 'u1', heading_path: 'A', content: 'alpha', summary: null, concepts: [] },
    { id: 2, collection_id: 1, source_id: 1, source_uri: 'u2', heading_path: 'B', content: 'beta', summary: null, concepts: [] },
    { id: 3, collection_id: 1, source_id: 1, source_uri: 'u3', heading_path: 'C', content: 'gamma', summary: null, concepts: [] },
  ];
}

function fakeDocStore(chunks: FakeChunk[]): DocStore {
  return {
    getCollectionByName: () => null,
    searchChunksFts: (_q: string, _opts: unknown) =>
      chunks.map((c, i) => ({ chunk_id: c.id, rank: -(chunks.length - i) })),
    getChunksByIds: (ids: number[]) => ids.map((id) => chunks.find((c) => c.id === id)).filter(Boolean),
    getCollection: () => ({ name: 'docs' }),
  } as unknown as DocStore;
}

function fakeReranker(scores: Record<number, number>): Reranker {
  return {
    rerank: vi.fn(async (_query: string, candidates: Array<{ chunk_id: number }>) => ({
      candidates,
      scoreByChunkId: new Map(Object.entries(scores).map(([k, v]) => [Number(k), v])),
      reranked: true,
      cacheHit: false,
      dropped: 0,
      modelId: 'fake',
      durationMs: 1,
    })),
  } as unknown as Reranker;
}

describe('DocHybridSearch relevance + threshold', () => {
  it('surfaces the calibrated rerank score and drops weak hits', async () => {
    const search = new DocHybridSearch(
      fakeDocStore(fakeChunks()),
      null,
      null,
      undefined,
      { reranker: fakeReranker({ 1: 0.9, 2: 0.2, 3: 0.6 }) },
    );
    const { results, diag } = await search.search({
      query: 'q',
      limit: 5,
      enhancements: { rerank: true },
      min_relevance: 0.45,
    });
    expect(results.map((r) => r.chunk_id)).toEqual([1, 3]); // 2 dropped (0.2)
    expect(results[0]!.relevance).toBeCloseTo(0.9);
    expect(results[0]!.relevance_source).toBe('rerank');
    expect(diag.rerank_used).toBe(true);
    expect(diag.no_good_match).toBe(false);
    expect(diag.top_relevance).toBeCloseTo(0.9);
  });

  it('reports no_good_match (empty) when nothing clears the threshold', async () => {
    const search = new DocHybridSearch(
      fakeDocStore(fakeChunks()),
      null,
      null,
      undefined,
      { reranker: fakeReranker({ 1: 0.3, 2: 0.2, 3: 0.1 }) },
    );
    const { results, diag } = await search.search({
      query: 'q',
      limit: 5,
      enhancements: { rerank: true },
      min_relevance: 0.45,
    });
    expect(results).toHaveLength(0);
    expect(diag.no_good_match).toBe(true);
    expect(diag.top_relevance).toBeCloseTo(0.3); // best rejected score still reported
  });

  it('passes through uncalibrated results when no reranker runs', async () => {
    const search = new DocHybridSearch(fakeDocStore(fakeChunks()), null, null);
    const { results, diag } = await search.search({ query: 'q', limit: 5, min_relevance: 0.45 });
    expect(results).toHaveLength(3);
    expect(results[0]!.relevance).toBeNull();
    expect(results[0]!.relevance_source).toBe('rrf');
    expect(diag.no_good_match).toBe(false);
    expect(diag.top_relevance).toBeNull();
  });
});
