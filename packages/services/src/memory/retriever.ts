import type { ContextSnapshot } from '@mcp/shared/types.js';

/**
 * Retrieves relevant project memory (snapshots) for the agent's current task,
 * blending semantic relevance with stored importance, and records access.
 *
 * Decoupled by structural interfaces so it doesn't hard-depend on the
 * concrete HybridSearch / CodeIndexDB classes — easy to unit-test with fakes
 * and to wire from the runner layer.
 *
 * v1 gating is structural: a minimum query length + a small top-K, with the
 * caller throttling WHEN it retrieves (session start + material task change).
 * An absolute relevance-score threshold is a later refinement (needs the
 * hybrid search to surface numeric scores).
 */

export interface SnapshotSearch {
  searchSnapshotsHybrid(
    projectId: number,
    projectName: string,
    query: string,
    limit: number,
  ): Promise<ContextSnapshot[]>;
}

export interface AccessMarker {
  markSnapshotAccessed(ids: number[]): void;
}

export interface RetrievedMemory {
  id: string;
  title: string;
  content: string;
  importance: number;
}

export interface MemoryRetrieverOptions {
  /** Items returned (and injected). Default 3. */
  topK?: number;
  /** Candidates fetched from hybrid search before re-ranking. Default max(topK*3, 10). */
  fetchK?: number;
  /** Skip retrieval for queries shorter than this (avoids noise). Default 12. */
  minQueryChars?: number;
}

export class MemoryRetriever {
  constructor(
    private readonly search: SnapshotSearch,
    private readonly access: AccessMarker,
    private readonly opts: MemoryRetrieverOptions = {},
  ) {}

  async retrieve(projectId: number, projectName: string, queryText: string): Promise<RetrievedMemory[]> {
    const q = queryText.trim();
    if (q.length < (this.opts.minQueryChars ?? 12)) return [];

    const topK = this.opts.topK ?? 3;
    const fetchK = this.opts.fetchK ?? Math.max(topK * 3, 10);

    const hits = await this.search.searchSnapshotsHybrid(projectId, projectName, q, fetchK);
    if (hits.length === 0) return [];

    // Blend semantic relevance (hybrid rank position) with stored importance,
    // so a highly-relevant low-importance note can still beat a marginally-
    // relevant high-importance one, but importance breaks near-ties.
    const scored = hits.map((snap, i) => ({
      snap,
      score: (1 / (i + 1)) * (0.5 + 0.5 * clamp01(snap.importance ?? 0.5)),
    }));
    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, topK);
    try {
      this.access.markSnapshotAccessed(top.map((t) => t.snap.id));
    } catch {
      /* access bump is best-effort — never fail retrieval over it */
    }

    return top.map((t) => ({
      id: String(t.snap.id),
      title: t.snap.title,
      content: t.snap.content,
      importance: clamp01(t.snap.importance ?? 0.5),
    }));
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
