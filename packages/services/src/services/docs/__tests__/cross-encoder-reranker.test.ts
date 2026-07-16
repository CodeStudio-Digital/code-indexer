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
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CrossEncoderReranker } from '../cross-encoder-reranker.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import { LocalReranker } from '@mcp/indexer/search/local-reranker.js';
import { createRerankerForTarget } from '@mcp/indexer/search/semantic-targets.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { RerankCandidate } from '../reranker.js';

const emptyProviders = {
  getProvider: () => null,
  getOAuth: () => null,
} as unknown as ProviderStore;

afterEach(() => vi.unstubAllGlobals());

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

  it('degrades and preserves RRF candidates when a strict provider target fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 503 })));
    const strictProvider = createRerankerForTarget({
      kind: 'local_http',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'reranker/model',
      protocol: 'openai-rerank',
    }, emptyProviders, { strict: true });

    const res = await new CrossEncoderReranker(strictProvider).rerank('q', cands());
    expect(res.reranked).toBe(false);
    expect(res.scoreByChunkId).toBeUndefined();
    expect(res.candidates.map((candidate) => candidate.chunk_id)).toEqual([1, 2, 3]);
  });

  it.each([
    ['partial', [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.8 },
    ]],
    ['duplicate', [
      { index: 0, score: 0.9 },
      { index: 0, score: 0.8 },
      { index: 2, score: 0.7 },
    ]],
  ])('degrades when a strict provider returns a %s result set', async (_case, rows) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: rows })));
    const strictProvider = createRerankerForTarget({
      kind: 'local_http',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'reranker/model',
      protocol: 'openai-rerank',
    }, emptyProviders, { strict: true });

    const res = await new CrossEncoderReranker(strictProvider).rerank('q', cands());
    expect(res.reranked).toBe(false);
    expect(res.scoreByChunkId).toBeUndefined();
    expect(res.candidates.map((candidate) => candidate.chunk_id)).toEqual([1, 2, 3]);
  });

  it('degrades and preserves RRF candidates when a strict local target fails to load', async () => {
    const strictLocal = new LocalReranker({ model: 'broken/model', strict: true });
    (strictLocal as unknown as { lease: { acquire: () => Promise<never> } }).lease = {
      acquire: async () => { throw new Error('incompatible ONNX model'); },
    };

    const res = await new CrossEncoderReranker(strictLocal).rerank('q', cands());
    expect(res.reranked).toBe(false);
    expect(res.scoreByChunkId).toBeUndefined();
    expect(res.candidates.map((candidate) => candidate.chunk_id)).toEqual([1, 2, 3]);
  });

  it('keeps successful strict target scores calibrated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
      { index: 1, score: 0.9 },
      { index: 2, score: 0.6 },
      { index: 0, score: 0.2 },
    ] })));
    const strictProvider = createRerankerForTarget({
      kind: 'local_http',
      baseUrl: 'http://localhost:8080/v1',
      model: 'reranker/model',
      protocol: 'openai-rerank',
    }, emptyProviders, { strict: true });

    const res = await new CrossEncoderReranker(strictProvider).rerank('q', cands());
    expect(res.reranked).toBe(true);
    expect(res.candidates.map((candidate) => candidate.chunk_id)).toEqual([2, 3, 1]);
    expect(res.scoreByChunkId?.get(2)).toBeCloseTo(0.9);
  });

  it('keeps a disabled Knowledge target uncalibrated in RRF order', async () => {
    const disabled = createRerankerForTarget(
      { kind: 'disabled' },
      emptyProviders,
      { strict: true },
    );
    const res = await new CrossEncoderReranker(disabled).rerank('q', cands());
    expect(res.reranked).toBe(false);
    expect(res.candidates.map((candidate) => candidate.chunk_id)).toEqual([1, 2, 3]);
  });

  it('leaves a single candidate unchanged', async () => {
    const res = await new CrossEncoderReranker(scoringService()).rerank('q', [cands()[0]!]);
    expect(res.reranked).toBe(false);
  });
});
