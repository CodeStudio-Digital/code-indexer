/**
 * Coverage for CrossEncoderReranker — the DocReranker that delegates to the
 * indexer's RerankerService (worker /rerank cross-encoder).
 *
 * Invariants:
 *   - reorders by the cross-encoder score and exposes scoreByChunkId
 *     (calibrated, feeds DocSearchResult.relevance);
 *   - honours scoreCutoff;
 *   - degrades to reranked=false (uncalibrated) on a null service, a thrown
 *     error, or a trivial (<=1) candidate set — never fabricates confidence.
 */
import { describe, it, expect } from 'vitest';
import { CrossEncoderReranker } from '../cross-encoder-reranker.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import type { RerankCandidate } from '../reranker.js';

function cands(): RerankCandidate[] {
  return [
    { chunk_id: 1, heading_path: 'A', snippet: 'alpha', pre_rerank_score: 0.5 },
    { chunk_id: 2, heading_path: 'B', snippet: 'beta', pre_rerank_score: 0.4 },
    { chunk_id: 3, heading_path: 'C', snippet: 'gamma', pre_rerank_score: 0.3 },
  ];
}

function service(name: string, impl?: RerankerService['rerank']): RerankerService {
  return { name, rerank: impl ?? (async () => []) } as RerankerService;
}

const SCORES: Record<string, number> = { '1': 0.2, '2': 0.9, '3': 0.6 };
const scoringService = (extra: Record<string, number> = {}) =>
  service('cloudflare', async (_q, docs) =>
    docs.map((d) => ({ id: d.id, score: { ...SCORES, ...extra }[d.id]!, originalScore: d.originalScore })),
  );

describe('CrossEncoderReranker', () => {
  it('reorders by cross-encoder score and exposes scoreByChunkId', async () => {
    const res = await new CrossEncoderReranker(scoringService()).rerank('q', cands());
    expect(res.reranked).toBe(true);
    expect(res.candidates.map((c) => c.chunk_id)).toEqual([2, 3, 1]);
    expect(res.scoreByChunkId?.get(2)).toBeCloseTo(0.9);
    expect(res.modelId).toBe('cloudflare');
  });

  it('drops candidates below the scoreCutoff', async () => {
    const res = await new CrossEncoderReranker(scoringService({ '1': 0.1 })).rerank('q', cands(), {
      scoreCutoff: 0.5,
    });
    expect(res.candidates.map((c) => c.chunk_id)).toEqual([2, 3]);
    expect(res.dropped).toBe(1);
  });

  it('degrades (reranked=false, uncalibrated) when the service is null', async () => {
    const res = await new CrossEncoderReranker(service('null')).rerank('q', cands());
    expect(res.reranked).toBe(false);
    expect(res.scoreByChunkId).toBeUndefined();
    expect(res.candidates.map((c) => c.chunk_id)).toEqual([1, 2, 3]);
  });

  it('degrades on a service error without throwing', async () => {
    const svc = service('cloudflare', async () => {
      throw new Error('boom');
    });
    const res = await new CrossEncoderReranker(svc).rerank('q', cands());
    expect(res.reranked).toBe(false);
    expect(res.candidates).toHaveLength(3);
  });

  it('leaves a single candidate unchanged', async () => {
    const res = await new CrossEncoderReranker(scoringService()).rerank('q', [cands()[0]!]);
    expect(res.reranked).toBe(false);
  });
});
