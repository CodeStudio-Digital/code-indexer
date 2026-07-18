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
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { Reranker } from '../reranker.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import { CrossEncoderReranker } from '../cross-encoder-reranker.js';

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

  it('over-fetches one candidate to report an honest top-K omission', async () => {
    const search = new DocHybridSearch(fakeDocStore(fakeChunks()), null, null);
    const { results, diag } = await search.search({ query: 'q', limit: 2 });
    expect(results).toHaveLength(2);
    expect(diag).toMatchObject({
      results_before_limit: 3,
      results_truncated: true,
    });
  });

  it('does not apply the calibrated threshold when the strict cross-encoder fails', async () => {
    const strictFailure: RerankerService = {
      name: 'strict-local',
      rerank: async () => { throw new Error('reranker unavailable'); },
    };
    const search = new DocHybridSearch(
      fakeDocStore(fakeChunks()),
      null,
      null,
      undefined,
      { reranker: new CrossEncoderReranker(strictFailure) },
    );

    const { results, diag } = await search.search({
      query: 'q',
      limit: 5,
      enhancements: { rerank: true },
      min_relevance: 0.45,
    });

    expect(results.map((result) => result.chunk_id)).toEqual([1, 2, 3]);
    expect(results.every((result) => result.relevance_source === 'rrf')).toBe(true);
    expect(diag.rerank_used).toBe(false);
    expect(diag.no_good_match).toBe(false);
    expect(diag.top_relevance).toBeNull();
  });

  it('does not truncate an explicit result limit to the legacy fixed 20', async () => {
    const chunks = Array.from({ length: 35 }, (_, index) => ({
      id: index + 1,
      collection_id: 1,
      source_id: 1,
      source_uri: `u${index + 1}`,
      heading_path: `H${index + 1}`,
      content: `content ${index + 1}`,
      summary: null,
      concepts: [],
    }));
    const search = new DocHybridSearch(fakeDocStore(chunks), null, null);

    const { results } = await search.search({ query: 'q', limit: 35 });

    expect(results).toHaveLength(35);
  });

  it('embeds each collection query in its active namespace model space', async () => {
    const chunks = [
      { ...fakeChunks()[0]!, id: 11, collection_id: 1 },
      { ...fakeChunks()[1]!, id: 22, collection_id: 2 },
    ];
    const namespaceCalls: string[] = [];
    const embeddingService = {
      embed: vi.fn(),
      embedQuery: vi.fn(async () => ({ vector: [99, 99], tokens: 0 })),
      embedQueryForNamespace: vi.fn(async (namespace: string) => {
        namespaceCalls.push(namespace);
        if (namespace === 'docs:c1') return { vector: [1, 0], tokens: 1, generationId: 41 };
        if (namespace === 'docs:c2') return { vector: [0, 1], tokens: 1, generationId: 42 };
        throw new Error('collection target unavailable');
      }),
      fingerprint: () => 'knowledge',
    } as unknown as EmbeddingService;
    const vectorStore = {
      search: vi.fn(async (vector: number[], options: { namespace?: string }) => {
        if (options.namespace === 'docs:c1' && vector[0] === 1) {
          return [{ id: 'doc_chunk:11', score: 0.9, metadata: { chunk_id: '11' } }];
        }
        if (options.namespace === 'docs:c2' && vector[1] === 1) {
          return [{ id: 'doc_chunk:22', score: 0.8, metadata: { chunk_id: '22' } }];
        }
        return [];
      }),
      upsert: vi.fn(), deleteByIds: vi.fn(), isAvailable: vi.fn(async () => true),
    } as unknown as VectorStore;
    const store = {
      ...fakeDocStore(chunks),
      listCollections: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
      getCollection: (id: number) => ({ id, name: `docs-${id}` }),
    } as unknown as DocStore;
    const search = new DocHybridSearch(store, embeddingService, vectorStore);

    const { results, diag } = await search.search({ query: 'q', mode: 'vector', limit: 5 });

    expect(namespaceCalls.sort()).toEqual(['docs:c1', 'docs:c2', 'docs:c3']);
    expect(embeddingService.embedQuery).not.toHaveBeenCalled();
    expect(vectorStore.search).toHaveBeenCalledWith([1, 0], expect.objectContaining({ generationId: 41 }));
    expect(vectorStore.search).toHaveBeenCalledWith([0, 1], expect.objectContaining({ generationId: 42 }));
    expect(results.map((result) => result.chunk_id).sort()).toEqual([11, 22]);
    expect(diag.vector_hits).toBe(2);
  });
});
