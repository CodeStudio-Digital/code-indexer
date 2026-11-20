/**
 * CrossEncoderReranker — a `DocReranker` that delegates to a real
 * cross-encoder (e.g. `@cf/baai/bge-reranker-v2-m3` via the worker's
 * `/rerank` endpoint) instead of the LLM-as-judge `Reranker`.
 *
 * Why: a cross-encoder scores (query, passage) pairs jointly and emits a
 * NATIVE relevance score that's better-calibrated than asking a chat model
 * to invent a 0-1 number. That score flows straight into
 * `DocSearchResult.relevance` (see relevance-policy), so the "no good match"
 * threshold and confidence bands get sharper.
 *
 * Reuse: wraps the indexer's existing `RerankerService` (local/provider/null)
 * rather than reimplementing each protocol. The server passes the Docs
 * profile's strict `SemanticProfileRuntime` proxy so failures remain visible
 * to this calibration boundary.
 *
 * The wiring site always uses this adapter with the Docs semantic
 * profile. A disabled profile supplies a `null` service and degrades to
 * `reranked=false`, preserving the incoming RRF order without switching to a
 * different model or vector space.
 *
 * No cache/telemetry here: the underlying worker call is a single fast
 * round-trip, and the LLM-path cache existed only to dodge expensive chat
 * calls. Kept deliberately thin.
 */
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import type { DocReranker, RerankCandidate, RerankResult, RerankOpts } from './reranker.js';

export class CrossEncoderReranker implements DocReranker {
  constructor(private service: RerankerService) {}

  async rerank<T extends RerankCandidate>(
    query: string,
    candidates: T[],
    opts: RerankOpts = {},
  ): Promise<RerankResult<T>> {
    opts.signal?.throwIfAborted();
    const started = Date.now();
    // Trivial input → don't claim a rerank happened, so the search layer marks
    // scores uncalibrated instead of trusting them.
    if (candidates.length <= 1) {
      return degraded(candidates, started, 'insufficient_candidates');
    }

    const docs = candidates.map((c) => ({
      id: String(c.chunk_id),
      text: c.snippet,
      originalScore: c.pre_rerank_score,
    }));

    let ranked: Array<{ id: string; score: number }>;
    let serviceName: string;
    try {
      // The live semantic proxy resolves the current target from the profile
      // here. Credential/config rotation can make that resolution fail, which
      // is the same degraded condition as an inference failure.
      serviceName = this.service.name;
      if (serviceName === 'null') return degraded(candidates, started, 'disabled');
      const blocked = this.service.queryBlockReason?.(query);
      if (blocked) return degraded(candidates, started, blocked);
      ranked = await (opts.signal ? this.service.rerank(query, docs, candidates.length, { signal: opts.signal })
        : this.service.rerank(query, docs, candidates.length));
      opts.signal?.throwIfAborted();
    } catch {
      opts.signal?.throwIfAborted();
      return degraded(candidates, started, 'inference_unavailable');
    }

    const scoreById = new Map<number, number>(ranked.map((r) => [Number(r.id), r.score]));
    if (scoreById.size !== candidates.length || ranked.length !== candidates.length ||
        candidates.some(c => !Number.isFinite(scoreById.get(c.chunk_id)))) {
      return degraded(candidates, started, 'incomplete_scores');
    }
    const cutoff = opts.scoreCutoff ?? 0;
    const reordered = candidates
      .map((c) => ({ c, score: scoreById.get(c.chunk_id) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .filter((x) => x.score >= cutoff)
      .map((x) => x.c);

    return {
      candidates: reordered,
      scoreByChunkId: new Map(candidates.map((c) => [c.chunk_id, scoreById.get(c.chunk_id) ?? 0])),
      reranked: true,
      cacheHit: false,
      dropped: candidates.length - reordered.length,
      modelId: serviceName,
      durationMs: Date.now() - started,
    };
  }
}

function degraded<T extends RerankCandidate>(candidates: T[], started: number, skipReason: string): RerankResult<T> {
  return {
    candidates,
    reranked: false,
    skipReason,
    cacheHit: false,
    dropped: 0,
    modelId: null,
    durationMs: Date.now() - started,
  };
}
