/**
 * Tests for the I1 V2 pipeline components.
 *
 * Focus on the pieces that are NET-NEW vs the legacy `HybridSearch.search()`:
 *   - `RrfFusionScorer`: scores grouped by candidateId, sums per-source contributions
 *   - `DedupFilter`: drops duplicate (type,id) rows from fan-out sources
 *   - `RerankerHydrator`: cross-encoder integration
 *
 * Full storage integration still goes through the search-quality bench
 * (`pnpm tsx src/benchmarks/search-quality.ts`); focused tests below use a
 * small FTS-only DB double to exercise the production stage wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HybridSearchResult } from '@mcp/shared/types.js';
import {
  createHybridSearchPipeline,
  DedupFilter,
  rerankDocumentText,
  RerankerHydrator,
  RrfFusionScorer,
  SearchCandidateSelector,
  runHybridSearchPipeline,
  type HybridSearchPipelineCandidate,
  type HybridSearchPipelineQuery,
} from '../hybrid-pipeline.js';
import { NullEmbeddingService } from '../embeddings.js';
import type { EmbeddingService } from '../embeddings.js';
import type { RerankCandidate, RerankerService } from '../reranker.js';
import { NullReranker } from '../reranker.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeResult(id: number, type: 'file' | 'symbol' = 'file'): HybridSearchResult {
  return {
    id,
    type,
    score: 0,
    fts_rank: null,
    vector_score: null,
    data: { id, path: `file-${id}.ts` } as unknown as HybridSearchResult['data'],
  };
}

function makeCandidate(
  id: number,
  ranks: HybridSearchPipelineCandidate['ranks'] = {},
): HybridSearchPipelineCandidate {
  return {
    candidateId: `file:${id}`,
    result: makeResult(id),
    ranks,
    score: 0,
  };
}

const emptyQuery: HybridSearchPipelineQuery = {
  queryId: 'q1',
  projectId: 1,
  projectName: 'test',
  query: 'something',
  type: 'all',
  overFetch: 30,
  limit: 10,
  diag: {},
};

describe('RrfFusionScorer', () => {
  const scorer = new RrfFusionScorer();
  const RRF_K = 60;

  it('single source: score = 1/(K + rank)', async () => {
    const candidates = [makeCandidate(1, { fts: 1 }), makeCandidate(2, { fts: 2 })];
    const out = await scorer.score(emptyQuery, candidates);
    expect(out[0].ok).toBe(true);
    if (!out[0].ok) return;
    expect(out[0].candidate.score).toBeCloseTo(1 / (RRF_K + 1));
    if (!out[1].ok) return;
    expect(out[1].candidate.score).toBeCloseTo(1 / (RRF_K + 2));
  });

  it('two sources for same candidate: score is sum of both contributions', async () => {
    // The same candidateId appears in both fts (rank 1) and vector (rank 3)
    const candidates = [
      makeCandidate(7, { fts: 1 }),
      makeCandidate(7, { vector: 3 }),
    ];
    const out = await scorer.score(emptyQuery, candidates);
    if (!out[0].ok) return;
    const expectedSum = 1 / (RRF_K + 1) + 1 / (RRF_K + 3);
    expect(out[0].candidate.score).toBeCloseTo(expectedSum);
    if (!out[1].ok) return;
    expect(out[1].candidate.score).toBeCloseTo(expectedSum);
  });

  it('three sources for same candidate: all three contributions add up', async () => {
    const candidates = [
      makeCandidate(11, { fts: 2 }),
      makeCandidate(11, { vector: 5 }),
      makeCandidate(11, { recent: 1 }),
    ];
    const out = await scorer.score(emptyQuery, candidates);
    if (!out[0].ok) return;
    const expected = 1 / (RRF_K + 2) + 1 / (RRF_K + 5) + 1 / (RRF_K + 1);
    expect(out[0].candidate.score).toBeCloseTo(expected);
  });

  it('returns same array length as input (Scorer contract)', async () => {
    const candidates = [makeCandidate(1, { fts: 1 }), makeCandidate(2, { vector: 1 })];
    const out = await scorer.score(emptyQuery, candidates);
    expect(out).toHaveLength(candidates.length);
  });

  it('candidate with no rank info gets score 0', async () => {
    const candidates = [makeCandidate(99, {})];
    const out = await scorer.score(emptyQuery, candidates);
    if (!out[0].ok) return;
    expect(out[0].candidate.score).toBe(0);
  });

  it('parity: same total score as the legacy two-stream rrfMerge math', async () => {
    // Legacy test corpus pattern: fts list [A,B,C], vector list [B,D,A]
    // Expected scores per RRF K=60:
    //   A: fts=1, vector=3 → 1/61 + 1/63
    //   B: fts=2, vector=1 → 1/62 + 1/61
    //   C: fts=3, vector=∅ → 1/63
    //   D: fts=∅, vector=2 → 1/62
    const candidates: HybridSearchPipelineCandidate[] = [
      { ...makeCandidate(1), candidateId: 'A', ranks: { fts: 1 } },
      { ...makeCandidate(2), candidateId: 'B', ranks: { fts: 2 } },
      { ...makeCandidate(3), candidateId: 'C', ranks: { fts: 3 } },
      { ...makeCandidate(2), candidateId: 'B', ranks: { vector: 1 } },
      { ...makeCandidate(4), candidateId: 'D', ranks: { vector: 2 } },
      { ...makeCandidate(1), candidateId: 'A', ranks: { vector: 3 } },
    ];
    const out = await scorer.score(emptyQuery, candidates);
    const byId = new Map<string, number>();
    for (const r of out) {
      if (r.ok) byId.set(r.candidate.candidateId, r.candidate.score);
    }
    expect(byId.get('A')).toBeCloseTo(1 / 61 + 1 / 63);
    expect(byId.get('B')).toBeCloseTo(1 / 62 + 1 / 61);
    expect(byId.get('C')).toBeCloseTo(1 / 63);
    expect(byId.get('D')).toBeCloseTo(1 / 62);
  });
});

describe('hybrid pipeline source fusion', () => {
  it('does not give repeated chunks extra RRF votes within one vector query', async () => {
    const pipeline = createHybridSearchPipeline({
      db: {
        searchFiles: () => [], searchSymbols: () => [],
        getSymbolById: (id: number) => ({ id, project_id: 1, file_path: `${id}.ts` }),
      } as unknown as CodeIndexDB,
      vectorStore: { search: async () => [
        { score: .95, metadata: { type: 'symbol', ref_id: '1' } },
        { score: .9, metadata: { type: 'symbol_body', ref_id: '2' } },
        { score: .8, metadata: { type: 'symbol_body', ref_id: '2' } },
        { score: .7, metadata: { type: 'symbol_group', ref_id: '2' } },
      ] } as unknown as VectorStore,
      embeddingService: {
        embed: async () => ({ vectors: [[1]], tokens: 1 }),
        embedQuery: async () => ({ vector: [1], tokens: 1 }),
      },
      hyde: null, reranker: new NullReranker(), recentFilesSource: null,
      ftsSanitize: query => query,
    });
    const results = await runHybridSearchPipeline(pipeline, { ...emptyQuery, query: 'lookupName', type: 'symbols', diag: {} });
    expect(results.map(row => row.id)).toEqual([1, 2]);
    expect(results[1].vector_score).toBe(.9);
  });
  it('sums FTS and vector ranks for the same candidate before deduplication', async () => {
    const file = {
      id: 7,
      project_id: 1,
      path: 'shared-result.ts',
    };
    const db = {
      searchFiles: () => [file],
      searchSymbols: () => [],
      getFileById: (id: number) => id === file.id ? file : undefined,
      getSymbolById: () => undefined,
    } as unknown as CodeIndexDB;
    const search = vi.fn(async () => [{
      id: 'vec-7',
      score: 0.91,
      metadata: { type: 'file', ref_id: String(file.id) },
    }]);
    const vectorStore = { search } as unknown as VectorStore;
    const embeddingService: EmbeddingService = {
      async embed() { return { vectors: [[1, 0]], tokens: 1 }; },
      async embedQuery() { return { vector: [1, 0], tokens: 1 }; },
      async embedQueryForNamespace() {
        return { vector: [1, 0], tokens: 1, generationId: 12 };
      },
    };
    const pipeline = createHybridSearchPipeline({
      db,
      vectorStore,
      embeddingService,
      hyde: null,
      reranker: new NullReranker(),
      recentFilesSource: null,
      ftsSanitize: (query) => query,
    });
    const query: HybridSearchPipelineQuery = {
      ...emptyQuery,
      query: 'sharedResult',
      type: 'files',
      overFetch: 10,
      limit: 10,
      diag: {},
    };

    const results = await runHybridSearchPipeline(pipeline, query);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: file.id,
      fts_rank: 1,
      vector_score: 0.91,
    });
    expect(results[0].score).toBeCloseTo(1 / 61 + 1 / 61);
    expect(search).toHaveBeenCalledWith(
      [1, 0],
      expect.objectContaining({ namespace: 'code:p1', generationId: 12 }),
    );
  });

  it('rehydrates symbol_body and symbol_group vectors for symbol searches', async () => {
    const symbol = {
      id: 44,
      project_id: 1,
      file_path: 'src/cache.ts',
      kind: 'function',
      name: 'invalidateCache',
      signature: 'invalidateCache(key: string): void',
    };
    const search = vi.fn(async () => [
      { id: 'body', score: 0.9, metadata: { type: 'symbol_body', ref_id: '44' } },
      { id: 'group', score: 0.8, metadata: { type: 'symbol_group', ref_id: '44' } },
    ]);
    const pipeline = createHybridSearchPipeline({
      db: {
        searchFiles: () => [],
        searchSymbols: () => [],
        getSymbolById: (id: number) => id === 44 ? symbol : undefined,
      } as unknown as CodeIndexDB,
      vectorStore: { search } as unknown as VectorStore,
      embeddingService: {
        async embed() { return { vectors: [[1, 0]], tokens: 1 }; },
        async embedQuery() { return { vector: [1, 0], tokens: 1 }; },
        async embedQueryForNamespace() { return { vector: [1, 0], tokens: 1, generationId: 3 }; },
      },
      hyde: null,
      reranker: new NullReranker(),
      recentFilesSource: null,
      ftsSanitize: (query) => query,
    });

    const results = await runHybridSearchPipeline(pipeline, {
      ...emptyQuery,
      query: 'related invalidation behavior',
      type: 'symbols',
      diag: {},
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 44, type: 'symbol' });
    expect(search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ filter: {}, namespace: 'code:p1', generationId: 3 }),
    );
  });
});

describe('concept candidate diversity', () => {
  it('preserves file diversity through final selection when reranking is skipped', async () => {
    const files = [{ id: 1, path: 'same.ts' }, { id: 2, path: 'other.ts' }];
    const symbols = [{ id: 3, file_path: 'same.ts', name: 'repeated' }];
    for (const reranker of [new NullReranker(), { name: 'unsupported', queryBlockReason: () => 'unsupported:pt', rerank: vi.fn() }]) {
      const pipeline = createHybridSearchPipeline({
        db: { searchFiles: () => files, searchSymbols: () => symbols } as unknown as CodeIndexDB,
        vectorStore: null, embeddingService: new NullEmbeddingService(), hyde: null,
        reranker, recentFilesSource: null, ftsSanitize: query => query,
      });
      const results = await runHybridSearchPipeline(pipeline, {
        ...emptyQuery, query: 'where is the session expiry checked?', limit: 3, diag: {},
      });
      expect(results.map(result => result.id)).toEqual([1, 2, 3]);
    }
  });
  it('records an unsupported-language skip without invoking the model', () => {
    const rerank = vi.fn();
    const hydrator = new RerankerHydrator({ name: 'local', queryBlockReason: () => 'unsupported:pt', rerank });
    const query = { ...emptyQuery, query: 'Onde fica a sessão?', diag: {} };
    expect(hydrator.enable(query)).toBe(false);
    expect(query.diag).toMatchObject({ rerankerApplied: false, rerankerSkippedReason: 'unsupported:pt' });
    expect(rerank).not.toHaveBeenCalled();
  });
  const selector = new SearchCandidateSelector('test', query => query.limit);
  const candidates = [1, 2, 3, 4].map(id => {
    const candidate = makeCandidate(id);
    candidate.score = 1 / (60 + id);
    candidate.result.data = { id, path: id < 4 ? 'same.ts' : 'other.ts' } as HybridSearchResult['data'];
    return candidate;
  });
  it('retains another file before spending the pool on repeated symbols', () => {
    expect(selector.select({ ...emptyQuery, query: 'where is session expiry?', limit: 2 }, candidates)
      .selected.map(candidate => candidate.result.id)).toEqual([1, 4]);
  });
  it('preserves exact-name and explicit symbol ordering', () => {
    for (const query of [{ ...emptyQuery, query: 'SessionPolicy' }, { ...emptyQuery, query: 'where is session expiry?', type: 'symbols' as const }]) {
      expect(selector.select({ ...query, limit: 2 }, candidates).selected.map(candidate => candidate.result.id)).toEqual([1, 2]);
    }
  });
});

describe('DedupFilter', () => {
  const filter = new DedupFilter();

  it('keeps unique candidates and removes dupes by candidateId', () => {
    const candidates = [
      makeCandidate(1),
      makeCandidate(2),
      makeCandidate(1), // dupe
      makeCandidate(3),
      makeCandidate(2), // dupe
    ];
    const out = filter.filter(emptyQuery, candidates);
    const keptIds = out.kept.map((c) => c.candidateId);
    expect(keptIds).toEqual(['file:1', 'file:2', 'file:3']);
    expect(out.removed).toHaveLength(2);
  });

  it('preserves first-occurrence order', () => {
    const candidates = [makeCandidate(3), makeCandidate(1), makeCandidate(2)];
    const out = filter.filter(emptyQuery, candidates);
    expect(out.kept.map((c) => c.result.id)).toEqual([3, 1, 2]);
    expect(out.removed).toHaveLength(0);
  });

  it('empty input → empty output', () => {
    const out = filter.filter(emptyQuery, []);
    expect(out.kept).toEqual([]);
    expect(out.removed).toEqual([]);
  });
});

describe('RerankerHydrator', () => {
  it('hydrates late symbols asynchronously and skips oversized sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerank-source-'));
    try {
      await writeFile(join(root, 'late.ts'), '// padding\n'.repeat(10000) + 'function lateNeedle() { return 42; }\n');
      await writeFile(join(root, 'huge.ts'), 'oversized-source'.repeat(200000));
      const rerank = vi.fn(async (_query: string, docs: RerankCandidate[]) => docs.map((c) => ({ id: c.id, score: 0.9, originalScore: c.originalScore })));
      const db = { getProject: () => ({ root_path: root }), getSymbolsByFile: () => [] } as unknown as CodeIndexDB;
      const late = makeCandidate(1);
      late.result = { ...makeResult(1, 'symbol'), data: {
        file_path: 'late.ts', name: 'lateNeedle', line: 10001, end_line: 10001,
      } as unknown as HybridSearchResult['data'] };
      const huge = makeCandidate(2);
      huge.result.data = { path: 'huge.ts' } as unknown as HybridSearchResult['data'];
      await new RerankerHydrator({ name: 'test', rerank }, db).hydrate({ ...emptyQuery, limit: 2, diag: {} }, [late, huge]);
      expect(rerank.mock.calls[0]![1][0]!.text).toContain('function lateNeedle() { return 42; }');
      expect(rerank.mock.calls[0]![1][1]!.text).not.toContain('oversized-source');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('is enabled when reranker is non-null', () => {
    const reranker: RerankerService = {
      name: 'mock',
      async rerank() { return []; },
    };
    const hydrator = new RerankerHydrator(reranker);
    expect(hydrator.enable(emptyQuery)).toBe(true);
  });

  it('rewrites scores from reranker output', async () => {
    const reranker: RerankerService = {
      name: 'mock',
      async rerank(_q, candidates) {
        return candidates.map((c, idx) => ({
          id: c.id,
          score: 100 - idx, // descending: first = 100, second = 99...
          originalScore: c.originalScore,
        }));
      },
    };
    const hydrator = new RerankerHydrator(reranker);
    const candidates = [
      { ...makeCandidate(1, { fts: 1 }), score: 0.5 },
      { ...makeCandidate(2, { fts: 2 }), score: 0.4 },
    ];
    const q: HybridSearchPipelineQuery = { ...emptyQuery, limit: 2, diag: {} };
    const out = await hydrator.hydrate(q, candidates);
    expect(out).toHaveLength(2);
    if (!out[0].ok || !out[1].ok) return;
    expect(out[0].candidate.score).toBe(100);
    expect(out[1].candidate.score).toBe(99);
    expect(out[0].candidate.result.score).toBe(100);
    expect(q.diag).toMatchObject({
      rerankerApplied: true,
      rerankerCandidates: 2,
      rerankerReturned: 2,
    });
  });

  it('preserves the complete RRF ordering when the reranker returns a partial set', async () => {
    const reranker: RerankerService = {
      name: 'mock',
      async rerank(_q, candidates) {
        // Return only the FIRST candidate; the second is "dropped" by rerank.
        return candidates.slice(0, 1).map((c) => ({
          id: c.id,
          score: 0.99,
          originalScore: c.originalScore,
        }));
      },
    };
    const hydrator = new RerankerHydrator(reranker);
    const candidates = [
      { ...makeCandidate(1), score: 0.5 },
      { ...makeCandidate(2), score: 0.4 },
    ];
    const q: HybridSearchPipelineQuery = { ...emptyQuery, limit: 2 };
    const out = await hydrator.hydrate(q, candidates);
    if (!out[0].ok || !out[1].ok) return;
    // Partial output is malformed: mixing cross-encoder and RRF score scales
    // would corrupt ordering, so the whole batch falls back atomically.
    expect(out[0].candidate.score).toBe(0.5);
    expect(out[1].candidate.score).toBe(0.4);
  });

  it('passes public topK to the reranker and keeps only its calibrated final set', async () => {
    const rerank = vi.fn(async (_q: string, candidates: RerankCandidate[], topK = 10) =>
      candidates.slice(1, 1 + topK).map((candidate, index) => ({
        id: candidate.id,
        score: 0.9 - index * 0.1,
        originalScore: candidate.originalScore,
      })));
    const hydrator = new RerankerHydrator({ name: 'adaptive', rerank });
    const candidates = [1, 2, 3, 4].map((id) => ({
      ...makeCandidate(id),
      score: 0.6 - id * 0.01,
    }));
    const q: HybridSearchPipelineQuery = { ...emptyQuery, limit: 2 };

    const out = await hydrator.hydrate(q, candidates);

    expect(rerank).toHaveBeenCalledWith(q.query, expect.any(Array), 2, {
      supersessionKey: undefined,
      signal: undefined,
    });
    const scores = out.map((row) => row.ok ? row.candidate.score : Number.NEGATIVE_INFINITY);
    expect(scores[1]).toBe(0.9);
    expect(scores[2]).toBe(0.8);
    expect(scores[0]).toBeLessThan(0.8);
    expect(scores[3]).toBeLessThan(0.8);
  });

  it('handles empty input gracefully', async () => {
    const reranker: RerankerService = { name: 'mock', async rerank() { return []; } };
    const hydrator = new RerankerHydrator(reranker);
    const out = await hydrator.hydrate(emptyQuery, []);
    expect(out).toEqual([]);
  });
});

describe('reranker document material', () => {
  it('uses structural file facts for file candidates', () => {
    const result = makeResult(1);
    result.data = {
      id: 1,
      path: 'src/cache.ts',
      language: 'typescript',
    } as unknown as HybridSearchResult['data'];

    const text = rerankDocumentText(result);

    expect(text).toContain('Path: src/cache.ts');
    expect(text).toContain('Language: typescript');
  });

  it('uses structural signature and comment for symbol candidates', () => {
    const result = makeResult(9, 'symbol');
    result.data = {
      id: 9,
      file_path: 'src/cache.ts',
      kind: 'function',
      name: 'invalidateCache',
      signature: 'invalidateCache(key: string): void',
      comment: 'Drops one cached entry.',
    } as unknown as HybridSearchResult['data'];

    const text = rerankDocumentText(result);

    expect(text).toContain('invalidateCache(key: string): void');
    expect(text).toContain('Drops one cached entry.');
  });
});

describe('hybrid pipeline rerank selection', () => {
  function createFtsOnlyPipeline(
    fileCount: number,
    reranker: RerankerService,
  ) {
    const files = Array.from({ length: fileCount }, (_, index) => {
      const id = index + 1;
      return {
        id,
        project_id: 1,
        path: `file-${id}.ts`,
      };
    });
    const db = {
      searchFiles: (_projectId: number, _query: string, limit: number) => files.slice(0, limit),
      searchSymbols: () => [],
    };
    return createHybridSearchPipeline({
      db: db as unknown as CodeIndexDB,
      vectorStore: null,
      embeddingService: new NullEmbeddingService(),
      hyde: null,
      reranker,
      recentFilesSource: null,
      ftsSanitize: (query) => query,
    });
  }

  it('reranks the expanded set and promotes a candidate before final top-K', async () => {
    vi.stubEnv('MCP_RERANK_DEPTH', '4');
    let candidatesSeen = 0;
    let requestedTopK = 0;
    const reranker: RerankerService = {
      name: 'promote-tail',
      async rerank(_query, candidates, topK = 10) {
        candidatesSeen = candidates.length;
        requestedTopK = topK;
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        return [
          { id: 'file:4', score: 0.99, originalScore: byId.get('file:4')!.originalScore },
          { id: 'file:2', score: 0.8, originalScore: byId.get('file:2')!.originalScore },
          { id: 'file:1', score: 0.2, originalScore: byId.get('file:1')!.originalScore },
          { id: 'file:3', score: 0.1, originalScore: byId.get('file:3')!.originalScore },
        ].slice(0, topK);
      },
    };
    const query: HybridSearchPipelineQuery = {
      ...emptyQuery,
      type: 'files',
      overFetch: 8,
      limit: 2,
      diag: {},
    };

    const results = await runHybridSearchPipeline(createFtsOnlyPipeline(4, reranker), query);

    expect(candidatesSeen).toBe(4);
    // The reranker sees the whole expanded candidate set, while topK tells
    // the worker how many calibrated rows must be returned after applying
    // its adaptive 20/40/64 candidate-depth policy.
    expect(requestedTopK).toBe(2);
    expect(results.map((result) => result.id)).toEqual([4, 2]);
    expect(results.map((result) => result.score)).toEqual([0.99, 0.8]);
    expect(results.every((result, index) => index === 0 || results[index - 1].score >= result.score)).toBe(true);
  });

  it('respects requested top-K above the former fixed limit of 20', async () => {
    vi.stubEnv('MCP_RERANK_DEPTH', '50');
    let candidatesSeen = 0;
    const reranker: RerankerService = {
      name: 'reverse',
      async rerank(_query, candidates, topK = 10) {
        candidatesSeen = candidates.length;
        return [...candidates]
          .reverse()
          .slice(0, topK)
          .map((candidate, index) => ({
            id: candidate.id,
            score: 1 - index / 100,
            originalScore: candidate.originalScore,
          }));
      },
    };
    const query: HybridSearchPipelineQuery = {
      ...emptyQuery,
      type: 'files',
      overFetch: 30,
      limit: 25,
      diag: {},
    };

    const results = await runHybridSearchPipeline(createFtsOnlyPipeline(30, reranker), query);

    expect(candidatesSeen).toBe(30);
    expect(results).toHaveLength(25);
    expect(results[0].id).toBe(30);
    expect(results[24].id).toBe(6);
    expect(results.every((result, index) => index === 0 || results[index - 1].score >= result.score)).toBe(true);
  });

  it('retains the adaptive worker candidate pool before reranking', async () => {
    let candidatesSeen = 0;
    const reranker: RerankerService = {
      name: 'adaptive-worker',
      candidatePoolSize: () => 40,
      async rerank(_query, candidates, topK = 10) {
        candidatesSeen = candidates.length;
        return candidates.slice(0, topK).map((candidate, index) => ({
          id: candidate.id,
          score: 1 - index / 100,
          originalScore: candidate.originalScore,
        }));
      },
    };
    const query: HybridSearchPipelineQuery = {
      ...emptyQuery,
      type: 'files',
      overFetch: 50,
      limit: 10,
      diag: {},
    };

    const results = await runHybridSearchPipeline(createFtsOnlyPipeline(50, reranker), query);

    expect(candidatesSeen).toBe(40);
    expect(results).toHaveLength(10);
  });

  it('falls back to RRF ordering when reranking fails', async () => {
    vi.stubEnv('MCP_RERANK_DEPTH', '6');
    const reranker: RerankerService = {
      name: 'throws',
      async rerank() { throw new Error('offline'); },
    };
    const query: HybridSearchPipelineQuery = {
      ...emptyQuery,
      type: 'files',
      overFetch: 6,
      limit: 3,
      diag: {},
    };

    const results = await runHybridSearchPipeline(createFtsOnlyPipeline(6, reranker), query);

    expect(results.map((result) => result.id)).toEqual([1, 2, 3]);
    expect(results.every((result, index) => index === 0 || results[index - 1].score >= result.score)).toBe(true);
    expect(query.diag).toMatchObject({
      rerankerApplied: false,
      rerankerCandidates: 6,
      rerankerReturned: 0,
      rerankerError: 'offline',
    });
  });

  it('forwards latest-wins identity and request cancellation to the reranker', async () => {
    let receivedOptions: { supersessionKey?: string; signal?: AbortSignal } | undefined;
    const controller = new AbortController();
    const reranker: RerankerService = {
      name: 'captures-request-options',
      async rerank(_query, candidates, topK = 10, options) {
        receivedOptions = options;
        return candidates.slice(0, topK).map((candidate) => ({
          id: candidate.id,
          score: candidate.originalScore,
          originalScore: candidate.originalScore,
        }));
      },
    };
    const query: HybridSearchPipelineQuery = {
      ...emptyQuery,
      type: 'files',
      overFetch: 4,
      limit: 2,
      supersessionKey: 'project:91:electron:search-everywhere:p91',
      signal: controller.signal,
      diag: {},
    };

    await runHybridSearchPipeline(createFtsOnlyPipeline(4, reranker), query);

    expect(receivedOptions).toEqual({
      supersessionKey: 'project:91:electron:search-everywhere:p91',
      signal: controller.signal,
    });
  });
});
