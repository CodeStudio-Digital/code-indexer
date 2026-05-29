/**
 * Coverage for relevance-policy — the shared threshold + confidence rules.
 *
 * Invariants:
 *   - Calibrated (rerank) scores band into high/medium/low; uncalibrated
 *     sources always report 'uncalibrated'.
 *   - applyThreshold only drops results when EVERY result is rerank-scored;
 *     uncalibrated sets pass through untouched (noGoodMatch=false).
 *   - When calibrated and nothing clears the cutoff, noGoodMatch=true and
 *     topRelevance still reports the best (rejected) score.
 */
import { describe, it, expect } from 'vitest';
import {
  applyThreshold,
  classifyConfidence,
  DEFAULT_MIN_RELEVANCE,
  type ThresholdableResult,
} from '../relevance-policy.js';

function r(relevance: number | null, source: ThresholdableResult['relevance_source']): ThresholdableResult {
  return { relevance, relevance_source: source };
}

describe('classifyConfidence', () => {
  it('bands calibrated rerank scores', () => {
    expect(classifyConfidence(0.9, 'rerank')).toBe('high');
    expect(classifyConfidence(0.6, 'rerank')).toBe('medium');
    expect(classifyConfidence(0.3, 'rerank')).toBe('low');
  });

  it('returns uncalibrated for non-rerank sources or null', () => {
    expect(classifyConfidence(0.99, 'rrf')).toBe('uncalibrated');
    expect(classifyConfidence(0.99, 'none')).toBe('uncalibrated');
    expect(classifyConfidence(null, 'rerank')).toBe('uncalibrated');
  });
});

describe('applyThreshold', () => {
  it('drops rerank-scored results below the cutoff', () => {
    const results = [r(0.9, 'rerank'), r(0.2, 'rerank'), r(0.5, 'rerank')];
    const { kept, noGoodMatch, topRelevance } = applyThreshold(results, DEFAULT_MIN_RELEVANCE);
    expect(kept.map((k) => k.relevance)).toEqual([0.9, 0.5]);
    expect(noGoodMatch).toBe(false);
    expect(topRelevance).toBeCloseTo(0.9);
  });

  it('flags no good match when everything is below the cutoff', () => {
    const results = [r(0.3, 'rerank'), r(0.2, 'rerank')];
    const { kept, noGoodMatch, topRelevance } = applyThreshold(results, 0.45);
    expect(kept).toHaveLength(0);
    expect(noGoodMatch).toBe(true);
    expect(topRelevance).toBeCloseTo(0.3);
  });

  it('never drops uncalibrated (rrf) results', () => {
    const results = [r(null, 'rrf'), r(null, 'rrf')];
    const { kept, noGoodMatch, topRelevance } = applyThreshold(results, 0.45);
    expect(kept).toHaveLength(2);
    expect(noGoodMatch).toBe(false);
    expect(topRelevance).toBeNull();
  });

  it('treats a mixed set as uncalibrated (refuses to threshold)', () => {
    const results = [r(0.9, 'rerank'), r(null, 'rrf')];
    const { kept, noGoodMatch } = applyThreshold(results, 0.45);
    expect(kept).toHaveLength(2);
    expect(noGoodMatch).toBe(false);
  });
});
