import { describe, it, expect } from 'vitest';
import {
  clusterByTitle,
  clusterByEmbedding,
  pickWinner,
  mergeContent,
  bumpImportance,
  planMerge,
} from '../cluster.js';
import type { ConsolSnapshot } from '../types.js';

function snap(id: number, over: Partial<ConsolSnapshot> = {}): ConsolSnapshot {
  return {
    id,
    category: 'decision',
    title: `t${id}`,
    content: `c${id}`,
    importance: 0.5,
    access_count: 0,
    last_accessed_at: null,
    created_at: '2026-01-01 00:00:00',
    ...over,
  };
}

describe('clusterByTitle', () => {
  it('groups near-identical titles into clusters of size ≥ 2, drops singletons', () => {
    const snaps = [
      snap(1, { title: 'Use JWT for auth' }),
      snap(2, { title: 'Use JWT auth' }),
      snap(3, { title: 'Completely different topic here' }),
    ];
    const clusters = clusterByTitle(snaps, 0.6);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual([1, 2]);
  });

  it('is idempotent: a lone survivor forms no cluster', () => {
    expect(clusterByTitle([snap(1, { title: 'Use JWT for auth' })], 0.6)).toEqual([]);
  });
});

describe('clusterByEmbedding', () => {
  const vmap = new Map<number, number[]>([
    [1, [1, 0]],
    [2, [1, 0.1]], // cosine ≈ 0.995 vs #1
    [3, [0, 1]], // cosine 0 vs #1/#2
  ]);
  it('links rows above the cosine threshold only', () => {
    const snaps = [snap(1), snap(2), snap(3)];
    const clusters = clusterByEmbedding(snaps, (id) => vmap.get(id), 0.92);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual([1, 2]);
  });
  it('does not link when a vector is missing', () => {
    const snaps = [snap(1), snap(2)];
    const clusters = clusterByEmbedding(snaps, (id) => (id === 1 ? vmap.get(1) : undefined), 0.92);
    expect(clusters).toEqual([]);
  });
});

describe('merge helpers', () => {
  it('pickWinner prefers highest importance, ties broken by earliest created_at', () => {
    const w = pickWinner([
      snap(1, { importance: 0.5, created_at: '2026-01-02 00:00:00' }),
      snap(2, { importance: 0.8, created_at: '2026-01-03 00:00:00' }),
      snap(3, { importance: 0.8, created_at: '2026-01-01 00:00:00' }),
    ]);
    expect(w.id).toBe(3); // 0.8 tie → earliest created_at
  });

  it('mergeContent appends only bodies not already present', () => {
    const winner = snap(1, { content: 'alpha' });
    const merged = mergeContent(winner, [snap(2, { content: 'beta' }), snap(3, { content: 'alpha' })]);
    expect(merged).toBe('alpha\n\nbeta');
  });

  it('bumpImportance grows with cluster size and saturates at 1', () => {
    expect(bumpImportance(0.5, 2)).toBeCloseTo(0.52);
    expect(bumpImportance(0.5, 5)).toBeCloseTo(0.58);
    expect(bumpImportance(0.99, 10)).toBe(1);
  });
});

describe('planMerge', () => {
  it('produces a deterministic, bumped plan with summed access', () => {
    const cluster = [
      snap(1, { importance: 0.6, content: 'a', access_count: 2, last_accessed_at: '2026-02-01 00:00:00' }),
      snap(2, { importance: 0.9, content: 'b', access_count: 5, last_accessed_at: '2026-03-01 00:00:00' }),
    ];
    const plan = planMerge(cluster);
    expect(plan.winnerId).toBe(2); // highest importance
    expect(plan.loserIds).toEqual([1]);
    expect(plan.content).toBe('b\n\na');
    expect(plan.importance).toBeCloseTo(0.92); // min(1, 0.9 + 0.02*1)
    expect(plan.accessCount).toBe(7);
    expect(plan.lastAccessedAt).toBe('2026-03-01 00:00:00');
  });

  it('returns null content when the winner already contains every body', () => {
    const cluster = [
      snap(1, { importance: 0.9, content: 'shared body' }),
      snap(2, { importance: 0.5, content: 'shared body' }),
    ];
    const plan = planMerge(cluster);
    expect(plan.winnerId).toBe(1);
    expect(plan.content).toBeNull(); // metadata-only path
    expect(plan.importance).toBeCloseTo(0.92);
  });
});
