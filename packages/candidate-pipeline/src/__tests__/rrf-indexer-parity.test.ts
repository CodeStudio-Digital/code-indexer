/**
 * Paridade test: the canonical `rrfMerge` in this package must produce
 * the SAME scores and ordering as the legacy in-line implementation that
 * used to live in `packages/indexer/src/search/hybrid.ts:342-382`.
 *
 * Locking down the formula:
 *   - K = 60 (RRF_K)
 *   - score per rank = 1 / (K + rank + 1)
 *   - duplicates across lists sum their per-list scores
 *
 * If a future change to `rrfMerge` breaks this test, the indexer's RRF
 * behavior would change — the test would tell us we MUST update the
 * search-quality benchmark expectations alongside.
 */
import { describe, expect, it } from 'vitest';
import { rrfMerge } from '../scorers/rrf.js';

const RRF_K = 60;

interface IndexerHit { candidateId: string; type: 'file' | 'symbol'; id: number; }

/** Faithful reproduction of the legacy rrfMerge (pre-extraction). */
function legacyRrfMerge(
  ftsResults: IndexerHit[],
  vectorResults: IndexerHit[],
  limit: number,
): Array<IndexerHit & { score: number }> {
  const scoreMap = new Map<string, IndexerHit & { score: number }>();
  for (let rank = 0; rank < ftsResults.length; rank++) {
    const r = ftsResults[rank];
    const key = `${r.type}:${r.id}`;
    const score = 1 / (RRF_K + rank + 1);
    if (scoreMap.has(key)) scoreMap.get(key)!.score += score;
    else scoreMap.set(key, { ...r, score });
  }
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const r = vectorResults[rank];
    const key = `${r.type}:${r.id}`;
    const score = 1 / (RRF_K + rank + 1);
    if (scoreMap.has(key)) scoreMap.get(key)!.score += score;
    else scoreMap.set(key, { ...r, score });
  }
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function makeHit(type: 'file' | 'symbol', id: number): IndexerHit {
  return { candidateId: `${type}:${id}`, type, id };
}

describe('rrfMerge parity with legacy indexer impl', () => {
  it('produces identical scores for overlapping fts + vector lists', () => {
    const fts = [
      makeHit('file', 1), makeHit('file', 2), makeHit('file', 3),
      makeHit('symbol', 10), makeHit('symbol', 11),
    ];
    const vec = [
      makeHit('file', 2), makeHit('symbol', 11), makeHit('file', 99),
      makeHit('symbol', 10), makeHit('file', 1),
    ];

    const legacy = legacyRrfMerge(fts, vec, 10);
    const merged = rrfMerge(
      [
        { name: 'fts', items: fts },
        { name: 'vec', items: vec },
      ],
      { k: RRF_K, limit: 10 },
    );

    expect(merged.length).toBe(legacy.length);
    for (let i = 0; i < legacy.length; i++) {
      expect(merged[i].candidateId).toBe(legacy[i].candidateId);
      expect(merged[i].rrfScore).toBeCloseTo(legacy[i].score, 9);
    }
  });

  it('respects limit', () => {
    const fts = Array.from({ length: 100 }, (_, i) => makeHit('file', i));
    const vec = Array.from({ length: 100 }, (_, i) => makeHit('file', 99 - i));
    const legacy = legacyRrfMerge(fts, vec, 20);
    const merged = rrfMerge(
      [{ items: fts }, { items: vec }],
      { k: RRF_K, limit: 20 },
    );
    expect(merged).toHaveLength(20);
    expect(legacy).toHaveLength(20);
    expect(merged.map((m) => m.candidateId)).toEqual(legacy.map((m) => m.candidateId));
  });

  it('handles disjoint lists', () => {
    const fts = [makeHit('file', 1), makeHit('file', 2)];
    const vec = [makeHit('symbol', 100), makeHit('symbol', 101)];
    const legacy = legacyRrfMerge(fts, vec, 4);
    const merged = rrfMerge(
      [{ items: fts }, { items: vec }],
      { k: RRF_K, limit: 4 },
    );
    expect(merged.map((m) => m.candidateId)).toEqual(legacy.map((m) => m.candidateId));
    for (let i = 0; i < merged.length; i++) {
      expect(merged[i].rrfScore).toBeCloseTo(legacy[i].score, 9);
    }
  });

  it('handles empty lists gracefully', () => {
    expect(rrfMerge([{ items: [] }, { items: [] }])).toEqual([]);
    expect(legacyRrfMerge([], [], 10)).toEqual([]);
  });
});
