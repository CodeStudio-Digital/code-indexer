/**
 * Coverage for the doc-RAG eval metrics (pure; the runner does the DB I/O).
 */
import { describe, it, expect } from 'vitest';
import {
  matchesSpec,
  labelRanked,
  successAtK,
  recallAtK,
  mrr,
  ndcgAtK,
  mean,
} from '../eval-metrics.js';

describe('matchesSpec', () => {
  it('matches by source_uri substring and heading substring', () => {
    expect(
      matchesSpec({ source_uri: 'https://x/Rigidbody.AddForce', heading_path: 'Physics > AddForce' }, { source_uri_contains: 'Rigidbody.AddForce' }),
    ).toBe(true);
    expect(
      matchesSpec({ source_uri: 'https://x/Other', heading_path: null }, { source_uri_contains: 'Rigidbody' }),
    ).toBe(false);
    expect(
      matchesSpec({ source_uri: null, heading_path: 'Hooks > useEffect' }, { heading_contains: 'useeffect' }),
    ).toBe(true);
  });

  it('an empty spec never matches', () => {
    expect(matchesSpec({ source_uri: 'x', heading_path: 'y' }, {})).toBe(false);
  });

  it('ANDs source_uri and heading within a single spec', () => {
    const spec = { source_uri_contains: 'useEffect', heading_contains: 'cleanup' };
    expect(matchesSpec({ source_uri: 'react/useEffect', heading_path: 'useEffect > Cleanup' }, spec)).toBe(true);
    expect(matchesSpec({ source_uri: 'react/useEffect', heading_path: 'useEffect > Params' }, spec)).toBe(false);
    expect(matchesSpec({ source_uri: 'react/useMemo', heading_path: 'Cleanup' }, spec)).toBe(false);
  });
});

describe('labelRanked', () => {
  it('credits each gold item at most once', () => {
    const results = [
      { source_uri: 'p/AddForce', heading_path: 'A' },
      { source_uri: 'p/AddForce', heading_path: 'A2' }, // same page, no new credit
      { source_uri: 'p/velocity', heading_path: 'B' },
    ];
    const gold = [{ source_uri_contains: 'AddForce' }, { source_uri_contains: 'velocity' }];
    expect(labelRanked(results, gold)).toEqual([true, false, true]);
  });
});

describe('metrics', () => {
  const ranked = [false, true, false, true]; // hits at ranks 2 and 4, numRelevant=2

  it('successAtK', () => {
    expect(successAtK(ranked, 1)).toBe(0);
    expect(successAtK(ranked, 2)).toBe(1);
  });

  it('recallAtK', () => {
    expect(recallAtK(ranked, 2, 2)).toBe(0.5);
    expect(recallAtK(ranked, 5, 2)).toBe(1);
    expect(recallAtK([], 5, 0)).toBe(0);
  });

  it('mrr', () => {
    expect(mrr(ranked)).toBeCloseTo(0.5);
    expect(mrr([false, false])).toBe(0);
  });

  it('ndcgAtK normalises against the ideal ranking', () => {
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3);
    expect(ndcgAtK(ranked, 5, 2)).toBeCloseTo(dcg / idcg);
    // A perfect ranking scores 1.0.
    expect(ndcgAtK([true, true, false], 3, 2)).toBeCloseTo(1);
  });

  it('mean', () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5);
    expect(mean([])).toBe(0);
  });
});
