/**
 * Relevance policy — the single source of truth for turning the doc
 * search's per-result relevance into (a) a hard "is this good enough"
 * threshold and (b) a human/agent-facing confidence label.
 *
 * Why a separate module? Both the agent-facing `docs_search` tool and the
 * bootstrap `rag_search_docs` tool need IDENTICAL semantics for "no good
 * match" and confidence. Centralising here keeps `search.ts` lean and
 * stops the two tools from drifting.
 *
 * Calibration caveat: only the reranker produces a calibrated 0-1 score.
 * Raw RRF scores are reciprocal-rank values (≈1/61…1/60) and are NOT
 * comparable across queries — so we REFUSE to threshold on them. When the
 * results aren't rerank-scored we report `uncalibrated` and keep every
 * result rather than dropping good hits on a meaningless cutoff.
 */

/** Default cutoff below which a rerank-scored result is "not good enough". */
export const DEFAULT_MIN_RELEVANCE = 0.45;

export type RelevanceSource = 'rerank' | 'rrf' | 'none';
export type Confidence = 'high' | 'medium' | 'low' | 'uncalibrated';

export interface ThresholdableResult {
  relevance: number | null;
  relevance_source: RelevanceSource;
}

/**
 * Map the top result's calibrated relevance to a coarse confidence band.
 * Returns `uncalibrated` whenever we don't have a rerank score to trust.
 */
export function classifyConfidence(
  topRelevance: number | null,
  source: RelevanceSource,
): Confidence {
  if (source !== 'rerank' || topRelevance == null) return 'uncalibrated';
  if (topRelevance >= 0.75) return 'high';
  if (topRelevance >= 0.55) return 'medium';
  return 'low';
}

export interface ThresholdOutcome<T> {
  /** Results that meet the threshold (or all results when uncalibrated). */
  kept: T[];
  /** True when calibrated scoring ran and NOTHING cleared the threshold. */
  noGoodMatch: boolean;
  /** Best relevance seen across the input (null when no calibrated score). */
  topRelevance: number | null;
}

/**
 * Drop results below `minRelevance` — but ONLY when every result carries a
 * calibrated rerank score. Uncalibrated result sets pass through untouched
 * (we can't honestly judge them), with `noGoodMatch=false`.
 */
export function applyThreshold<T extends ThresholdableResult>(
  results: T[],
  minRelevance: number = DEFAULT_MIN_RELEVANCE,
): ThresholdOutcome<T> {
  const calibrated =
    results.length > 0 &&
    results.every((r) => r.relevance_source === 'rerank' && r.relevance != null);

  if (!calibrated) {
    return { kept: results, noGoodMatch: false, topRelevance: null };
  }

  const topRelevance = results.reduce<number>((max, r) => Math.max(max, r.relevance ?? 0), 0);
  const kept = results.filter((r) => (r.relevance ?? 0) >= minRelevance);
  return { kept, noGoodMatch: kept.length === 0, topRelevance };
}
