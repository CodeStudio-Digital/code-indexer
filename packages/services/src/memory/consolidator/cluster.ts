import { cosine, titleSimilarity } from '../text-sim.js';
import type { ConsolSnapshot, MergePlan } from './types.js';

/**
 * Single-link clustering + merge planning for near-duplicate snapshots.
 * Pure: no DB, no embeddings backend — vectors are passed in.
 */

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/** Group indices that share a root into clusters of size ≥ 2 (ids, not indices). */
function rootsToClusters(snaps: ConsolSnapshot[], uf: UnionFind): number[][] {
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < snaps.length; i++) {
    const r = uf.find(i);
    const list = byRoot.get(r) ?? [];
    list.push(snaps[i].id);
    byRoot.set(r, list);
  }
  return [...byRoot.values()].filter((c) => c.length >= 2);
}

/**
 * Cluster a homogeneous (same-category) group by embedding cosine. `vectorOf`
 * returns the row's vector or undefined; pairs where either is missing are not
 * linked (they fall through to no-merge, which is safe).
 */
export function clusterByEmbedding(
  snaps: ConsolSnapshot[],
  vectorOf: (id: number) => number[] | undefined,
  threshold: number,
): number[][] {
  const uf = new UnionFind(snaps.length);
  for (let i = 0; i < snaps.length; i++) {
    const vi = vectorOf(snaps[i].id);
    if (!vi) continue;
    for (let j = i + 1; j < snaps.length; j++) {
      const vj = vectorOf(snaps[j].id);
      if (!vj) continue;
      if (cosine(vi, vj) >= threshold) uf.union(i, j);
    }
  }
  return rootsToClusters(snaps, uf);
}

/** Cluster a same-category group by title Jaccard-min (no embedding backend). */
export function clusterByTitle(snaps: ConsolSnapshot[], threshold: number): number[][] {
  const uf = new UnionFind(snaps.length);
  for (let i = 0; i < snaps.length; i++) {
    for (let j = i + 1; j < snaps.length; j++) {
      if (titleSimilarity(snaps[i].title, snaps[j].title) >= threshold) uf.union(i, j);
    }
  }
  return rootsToClusters(snaps, uf);
}

/** Deterministic winner: highest importance, ties broken by earliest created_at. */
export function pickWinner(cluster: ConsolSnapshot[]): ConsolSnapshot {
  return [...cluster].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id;
  })[0];
}

/** Append each loser body to the winner only when not already present. */
export function mergeContent(winner: ConsolSnapshot, losers: ConsolSnapshot[]): string {
  let content = winner.content;
  for (const l of losers) {
    const body = l.content.trim();
    if (body && !content.includes(body)) content = `${content}\n\n${body}`;
  }
  return content;
}

/** Evidence-based bump: more corroborating rows → slightly higher, capped at 1. */
export function bumpImportance(maxImportance: number, clusterSize: number): number {
  return Math.min(1, maxImportance + 0.02 * (clusterSize - 1));
}

/** Build a deterministic, idempotent merge plan for one cluster of ids. */
export function planMerge(cluster: ConsolSnapshot[]): MergePlan {
  const winner = pickWinner(cluster);
  const losers = cluster.filter((s) => s.id !== winner.id);
  const merged = mergeContent(winner, losers);
  const maxImportance = Math.max(...cluster.map((s) => s.importance ?? 0.5));
  const lastAccessedAt = cluster
    .map((s) => s.last_accessed_at)
    .filter((v): v is string => !!v)
    .sort()
    .pop() ?? null;
  return {
    winnerId: winner.id,
    loserIds: losers.map((s) => s.id),
    content: merged !== winner.content ? merged : null,
    importance: bumpImportance(maxImportance, cluster.length),
    accessCount: cluster.reduce((sum, s) => sum + (s.access_count ?? 0), 0),
    lastAccessedAt,
  };
}
