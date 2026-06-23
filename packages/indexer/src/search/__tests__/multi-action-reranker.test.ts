/**
 * Tests for I5 — Multi-action reranker.
 *
 * Locks in:
 *   - NullMultiActionReranker passes through `relevance = originalScore`
 *   - SingleActionAdapter wraps a legacy reranker correctly
 *   - weightedActionFusion: Σ(weight × action), sorted desc by score
 *   - Missing actions / missing weights contribute 0
 *   - toRerankResults: shape-compatible with legacy callers
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTION_WEIGHTS,
  NullMultiActionReranker,
  SingleActionAdapter,
  toRerankResults,
  weightedActionFusion,
  type ActionWeights,
  type MultiActionRerankResult,
} from '../multi-action-reranker.js';
import type { RerankCandidate, RerankerService } from '../reranker.js';

function candidate(id: string, originalScore = 0.5): RerankCandidate {
  return { id, text: `text for ${id}`, originalScore };
}

describe('NullMultiActionReranker', () => {
  it('returns one action "relevance" equal to originalScore', async () => {
    const r = new NullMultiActionReranker();
    const out = await r.rerank('q', [candidate('a', 0.8), candidate('b', 0.6)]);
    expect(out).toHaveLength(2);
    expect(out[0].actions.relevance).toBe(0.8);
    expect(out[1].actions.relevance).toBe(0.6);
    // No other actions
    expect(Object.keys(out[0].actions)).toEqual(['relevance']);
  });

  it('honors topK', async () => {
    const r = new NullMultiActionReranker();
    const out = await r.rerank('q', [candidate('a'), candidate('b'), candidate('c')], 2);
    expect(out).toHaveLength(2);
  });
});

describe('SingleActionAdapter', () => {
  it('wraps a legacy reranker into the multi-action interface', async () => {
    const legacy: RerankerService = {
      name: 'legacy',
      async rerank(_q, candidates, topK = 10) {
        return candidates.slice(0, topK).map((c) => ({
          id: c.id,
          score: c.originalScore * 2,
          originalScore: c.originalScore,
        }));
      },
    };
    const adapter = new SingleActionAdapter(legacy);
    expect(adapter.name).toContain('legacy');
    const out = await adapter.rerank('q', [candidate('a', 0.5)]);
    expect(out[0].actions.relevance).toBe(1.0);
    expect(out[0].originalScore).toBe(0.5);
  });
});

describe('weightedActionFusion', () => {
  it('applies default weights when none provided', () => {
    const results: MultiActionRerankResult[] = [
      { id: 'a', actions: { relevance: 0.9, freshness: 0.5 }, originalScore: 0.5 },
    ];
    const fused = weightedActionFusion(results);
    // 1.0 * 0.9 + 0.2 * 0.5 = 1.0
    expect(fused[0].score).toBeCloseTo(1.0 * 0.9 + 0.2 * 0.5);
    expect(fused[0].contributions.relevance).toBeCloseTo(0.9);
    expect(fused[0].contributions.freshness).toBeCloseTo(0.1);
  });

  it('honors custom weights', () => {
    const weights: ActionWeights = { relevance: 1.0, freshness: 1.0 };
    const results: MultiActionRerankResult[] = [
      { id: 'a', actions: { relevance: 0.5, freshness: 0.5 }, originalScore: 0.5 },
    ];
    const fused = weightedActionFusion(results, weights);
    expect(fused[0].score).toBeCloseTo(1.0);
  });

  it('actions missing from the result contribute 0', () => {
    const results: MultiActionRerankResult[] = [
      { id: 'a', actions: { relevance: 0.9 }, originalScore: 0.9 },
    ];
    const fused = weightedActionFusion(results, { relevance: 1.0, freshness: 0.5 });
    expect(fused[0].score).toBeCloseTo(0.9);
    expect(fused[0].contributions.freshness).toBeUndefined();
  });

  it('weights missing for an action contribute 0', () => {
    const results: MultiActionRerankResult[] = [
      { id: 'a', actions: { relevance: 0.5, freshness: 0.5 }, originalScore: 0.5 },
    ];
    const fused = weightedActionFusion(results, { relevance: 1.0 }); // no freshness
    expect(fused[0].score).toBeCloseTo(0.5);
    expect(fused[0].contributions.freshness).toBeUndefined();
  });

  it('sorts by fused score descending', () => {
    const results: MultiActionRerankResult[] = [
      { id: 'low', actions: { relevance: 0.2 }, originalScore: 0.2 },
      { id: 'high', actions: { relevance: 0.9 }, originalScore: 0.9 },
      { id: 'mid', actions: { relevance: 0.5 }, originalScore: 0.5 },
    ];
    const fused = weightedActionFusion(results);
    expect(fused.map((f) => f.id)).toEqual(['high', 'mid', 'low']);
  });

  it('empty input → empty output', () => {
    expect(weightedActionFusion([])).toEqual([]);
  });

  it('ablation: weight=0 drops the action contribution', () => {
    const results: MultiActionRerankResult[] = [
      { id: 'a', actions: { relevance: 0.9, freshness: 0.9 }, originalScore: 0.5 },
    ];
    const fused = weightedActionFusion(results, { relevance: 1.0, freshness: 0 });
    expect(fused[0].score).toBeCloseTo(0.9); // freshness contribution = 0
    expect(fused[0].contributions.freshness).toBeUndefined();
  });
});

describe('toRerankResults', () => {
  it('projects fused output back to legacy shape', () => {
    const results: MultiActionRerankResult[] = [
      { id: 'a', actions: { relevance: 0.7, scope_match: 0.5 }, originalScore: 0.6 },
    ];
    const fused = weightedActionFusion(results);
    const legacy = toRerankResults(fused);
    expect(legacy).toEqual([
      { id: 'a', score: fused[0].score, originalScore: 0.6 },
    ]);
  });
});

describe('DEFAULT_ACTION_WEIGHTS', () => {
  it('relevance dominates', () => {
    expect(DEFAULT_ACTION_WEIGHTS.relevance).toBe(1.0);
    expect(DEFAULT_ACTION_WEIGHTS.freshness).toBeLessThan(DEFAULT_ACTION_WEIGHTS.relevance!);
  });

  it('is frozen — defensive against accidental mutation', () => {
    expect(Object.isFrozen(DEFAULT_ACTION_WEIGHTS)).toBe(true);
  });
});
