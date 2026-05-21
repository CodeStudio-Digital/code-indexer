/**
 * Tests for individual scorers. These pin down the formulas verbatim so a
 * future refactor doesn't silently change scoring semantics.
 */
import { describe, expect, it } from 'vitest';
import { rrfMerge } from '../scorers/rrf.js';
import { weightedSum } from '../scorers/weighted-sum.js';
import { cosineSimilarity, cosineSimilarities, l2Normalize, dot } from '../scorers/two-tower.js';
import { recencyDecay } from '../scorers/recency-decay.js';
import { batchFrequencyBoost } from '../scorers/frequency-boost.js';

describe('rrfMerge', () => {
  it('combines two ranked lists with the K=60 default', () => {
    const fts = [
      { candidateId: 'a' },
      { candidateId: 'b' },
      { candidateId: 'c' },
    ];
    const vec = [
      { candidateId: 'b' },
      { candidateId: 'd' },
      { candidateId: 'a' },
    ];
    const merged = rrfMerge([{ name: 'fts', items: fts }, { name: 'vec', items: vec }]);
    // `b` appears in both at ranks 1 and 0 → highest score.
    // `a` appears in both at ranks 0 and 2.
    // `c` only in fts at rank 2.
    // `d` only in vec at rank 1.
    expect(merged[0].candidateId).toBe('b'); // 1/61 + 1/61 ≈ 0.0328
    expect(merged[1].candidateId).toBe('a'); // 1/61 + 1/63 ≈ 0.0322
    expect(merged.find((m) => m.candidateId === 'c')?.rrfScore).toBeCloseTo(1 / 63, 5);
    expect(merged.find((m) => m.candidateId === 'd')?.rrfScore).toBeCloseTo(1 / 62, 5);
  });

  it('respects limit', () => {
    const a = [{ candidateId: 'x' }, { candidateId: 'y' }, { candidateId: 'z' }];
    const merged = rrfMerge([{ items: a }], { limit: 2 });
    expect(merged).toHaveLength(2);
  });
});

describe('weightedSum', () => {
  it('combines positive signals with positive offset', () => {
    const result = weightedSum([
      { name: 'task',   value: 0.8, weight: 1.0 },
      { name: 'recent', value: 0.5, weight: 0.3 },
    ]);
    expect(result.combined).toBeCloseTo(0.95, 5);
    expect(result.score).toBeCloseTo(1.95, 5); // combined + offset(1.0)
  });

  it('normalizes negative-only signals via the negative offset formula', () => {
    const result = weightedSum([
      { name: 'block', value: 1.0, weight: -0.5 },
      { name: 'mute',  value: 1.0, weight: -0.5 },
    ]);
    // combined = -1.0, totalAbs = 1.0, negSum = 1.0
    // normalized = ((-1.0 + 1.0) / 1.0) * 1.0 = 0
    expect(result.score).toBeCloseTo(0, 5);
  });

  it('reports per-signal contribution', () => {
    const result = weightedSum([
      { name: 'A', value: 0.5, weight: 2.0 },
      { name: 'B', value: 0.3, weight: -1.0 },
    ]);
    expect(result.contributions).toHaveLength(2);
    expect(result.contributions[0].contribution).toBeCloseTo(1.0, 5);
    expect(result.contributions[1].contribution).toBeCloseTo(-0.3, 5);
  });
});

describe('two-tower', () => {
  it('l2 normalizes a vector', () => {
    const out = l2Normalize([3, 4]);
    expect(dot(out, out)).toBeCloseTo(1, 5);
  });

  it('cosineSimilarity = 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });

  it('cosineSimilarity = 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it('batch cosineSimilarities preserves order', () => {
    const scores = cosineSimilarities([1, 0], [[1, 0], [0, 1], [1, 1]]);
    expect(scores[0]).toBeCloseTo(1, 5);
    expect(scores[1]).toBeCloseTo(0, 5);
    expect(scores[2]).toBeCloseTo(Math.cos(Math.PI / 4), 5);
  });
});

describe('recencyDecay', () => {
  it('returns 1.0 at age 0', () => {
    expect(recencyDecay(Date.now(), { halfLifeMs: 1000 })).toBeCloseTo(1, 3);
  });

  it('returns 0.5 at the half-life', () => {
    const now = Date.now();
    expect(recencyDecay(now - 1000, { halfLifeMs: 1000, now })).toBeCloseTo(0.5, 5);
  });

  it('returns 0.25 at 2×half-life', () => {
    const now = Date.now();
    expect(recencyDecay(now - 2000, { halfLifeMs: 1000, now })).toBeCloseTo(0.25, 5);
  });
});

describe('frequencyBoost', () => {
  it('saturates after N occurrences', () => {
    const now = Date.now();
    const events = Array.from({ length: 10 }, (_, i) => ({
      candidateId: 'tool_a',
      timestampMs: now - 100,
    }));
    const [boost] = batchFrequencyBoost(['tool_a'], events, {
      windowMs: 1000,
      now,
      maxBoost: 1,
      saturationCount: 5,
    });
    expect(boost).toBeCloseTo(1, 5);
  });

  it('returns 0 for items outside the window', () => {
    const now = Date.now();
    const events = [
      { candidateId: 'tool_a', timestampMs: now - 5000 }, // outside window
    ];
    const [boost] = batchFrequencyBoost(['tool_a'], events, {
      windowMs: 1000,
      now,
    });
    expect(boost).toBeCloseTo(0, 5);
  });
});
