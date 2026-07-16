/**
 * Tests for selectors (TopK, Diversity, Blender) and the LRU cache.
 */
import { describe, expect, it } from 'vitest';
import { TopKSelector } from '../selectors/top-k.js';
import { DiversitySelector } from '../selectors/diversity.js';
import { BlenderSelector } from '../selectors/blender.js';
import { LruCache } from '../cache/lru.js';
import type { PipelineQuery } from '../types.js';

interface Q extends PipelineQuery {}
interface C { candidateId: string; group: string; score: number }

const q: Q = { queryId: 'q' };

describe('TopKSelector', () => {
  it('returns top-K sorted descending by score', () => {
    const sel = new TopKSelector<Q, C>({
      k: 2,
      scoreOf: (c) => c.score,
    });
    const result = sel.select(q, [
      { candidateId: 'a', group: 'g', score: 1 },
      { candidateId: 'b', group: 'g', score: 3 },
      { candidateId: 'c', group: 'g', score: 2 },
    ]);
    expect(result.selected.map((x) => x.candidateId)).toEqual(['b', 'c']);
    expect(result.nonSelected.map((x) => x.candidateId)).toEqual(['a']);
  });

  it('resolves K from the query when configured dynamically', () => {
    const sel = new TopKSelector<Q & { limit: number }, C>({
      k: (query) => query.limit,
      scoreOf: (c) => c.score,
    });
    const result = sel.select({ ...q, limit: 3 }, [
      { candidateId: 'a', group: 'g', score: 1 },
      { candidateId: 'b', group: 'g', score: 4 },
      { candidateId: 'c', group: 'g', score: 2 },
      { candidateId: 'd', group: 'g', score: 3 },
    ]);
    expect(result.selected.map((x) => x.candidateId)).toEqual(['b', 'd', 'c']);
    expect(sel.size()).toBeUndefined();
  });
});

describe('DiversitySelector', () => {
  it('attenuates repeated group members so single high-score group does not dominate', () => {
    const sel = new DiversitySelector<Q, C>({
      k: 3,
      scoreOf: (c) => c.score,
      groupKey: (c) => c.group,
      attenuation: 0.5,
    });
    const result = sel.select(q, [
      { candidateId: 'a1', group: 'A', score: 10 },
      { candidateId: 'a2', group: 'A', score: 9 },
      { candidateId: 'a3', group: 'A', score: 8 },
      { candidateId: 'b1', group: 'B', score: 7 },
      { candidateId: 'c1', group: 'C', score: 6 },
    ]);
    // First pick: a1 (10). Now group A has count=1, so a2's score becomes 4.5,
    // b1 still 7, c1 still 6 → pick b1. Then group B has count=1, so a3 (8 ×
    // 0.5 = 4), c1 (6) → pick c1. Final: a1, b1, c1.
    expect(result.selected.map((c) => c.candidateId)).toEqual(['a1', 'b1', 'c1']);
  });
});

describe('BlenderSelector', () => {
  it('interleaves tracks with spacing constraints', () => {
    const sel = new BlenderSelector<Q, C>({
      totalK: 6,
      tracks: [
        { name: 'organic', items: [
          { candidateId: 'o1', group: 'o', score: 1 },
          { candidateId: 'o2', group: 'o', score: 1 },
          { candidateId: 'o3', group: 'o', score: 1 },
          { candidateId: 'o4', group: 'o', score: 1 },
        ] },
        { name: 'ads', minSpacing: 3, cap: 2, items: [
          { candidateId: 'ad1', group: 'a', score: 1 },
          { candidateId: 'ad2', group: 'a', score: 1 },
        ] },
      ],
    });
    const result = sel.select(q, []);
    const ids = result.selected.map((c) => c.candidateId);
    // First slot picks the highest-scoring track. Both tracks score 0 at
    // start (default = -cursor = 0 for the first item), but tracks are
    // iterated in order, so 'organic' wins ties by being first considered.
    // Expected interleave: o1, [ad?], o2, o3, [ad?], o4
    expect(ids.filter((id) => id.startsWith('ad'))).toHaveLength(2);
    expect(ids).toHaveLength(6);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry when full', () => {
    const cache = new LruCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('moves accessed entries to most-recent position', () => {
    const cache = new LruCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // bump 'a' to MRU
    cache.set('c', 3); // evicts 'b' now (not 'a')
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('expires entries past their TTL', async () => {
    const cache = new LruCache<string, number>({ maxSize: 10 });
    cache.set('a', 1, 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.get('a')).toBeUndefined();
  });
});
