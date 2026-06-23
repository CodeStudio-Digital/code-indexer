/**
 * Tests for the I1 V2 pipeline components.
 *
 * Focus on the pieces that are NET-NEW vs the legacy `HybridSearch.search()`:
 *   - `RrfFusionScorer`: scores grouped by candidateId, sums per-source contributions
 *   - `DedupFilter`: drops duplicate (type,id) rows from fan-out sources
 *   - `RerankerHydrator`: cross-encoder integration
 *
 * The full pipeline integration (FtsSource + VectorSource + RecentFilesSourceStage
 * orchestrated by CandidatePipeline) needs a real DB and goes through the
 * search-quality bench (`pnpm tsx src/benchmarks/search-quality.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { HybridSearchResult } from '@mcp/shared/types.js';
import {
  DedupFilter,
  RerankerHydrator,
  RrfFusionScorer,
  type HybridSearchPipelineCandidate,
  type HybridSearchPipelineQuery,
} from '../hybrid-pipeline.js';
import type { RerankerService } from '../reranker.js';

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
  it('is enabled when reranker is non-null', () => {
    const reranker: RerankerService = {
      name: 'mock',
      async rerank() { return []; },
    };
    const hydrator = new RerankerHydrator(reranker);
    expect(hydrator.enable()).toBe(true);
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
    const q: HybridSearchPipelineQuery = { ...emptyQuery, limit: 2 };
    const out = await hydrator.hydrate(q, candidates);
    expect(out).toHaveLength(2);
    if (!out[0].ok || !out[1].ok) return;
    expect(out[0].candidate.score).toBe(100);
    expect(out[1].candidate.score).toBe(99);
    expect(out[0].candidate.result.score).toBe(100);
  });

  it('preserves score on candidates the reranker did not score', async () => {
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
    // First got the rerank score; second kept its RRF score.
    expect(out[0].candidate.score).toBe(0.99);
    expect(out[1].candidate.score).toBe(0.4);
  });

  it('handles empty input gracefully', async () => {
    const reranker: RerankerService = { name: 'mock', async rerank() { return []; } };
    const hydrator = new RerankerHydrator(reranker);
    const out = await hydrator.hydrate(emptyQuery, []);
    expect(out).toEqual([]);
  });
});
