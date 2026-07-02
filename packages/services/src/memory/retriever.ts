import type { ContextSnapshot } from '@mcp/shared/types.js';
import { recencyDecay } from '@mcp/candidate-pipeline';
import { blendedMemoryScore } from './scoring.js';

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
 *
 * D1 — an opt-in `minRelevance` floor now drops weak candidates BEFORE the topK
 * slice (CC's "if unsure, don't include it"), with a stricter bar for
 * conservative categories ("be especially conservative with user-profile
 * memories"). It floors the BLENDED score (rank×importance×recency×staleness);
 * a floor on the RAW hybrid score still needs the hybrid search to surface it.
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

/**
 * Optional staleness dependency — the CodeIndexDB satisfies it. When the
 * `access` object lacks it (e.g. test fakes), retrieval skips the staleness
 * discount + note and behaves as before.
 */
export interface StaleFilesBatch {
  getStaleSnapshotFilesBatch(
    ids: number[],
    projectId: number,
  ): Map<number, { stale: string[]; total: number }>;
}

export interface RetrievedMemory {
  id: string;
  title: string;
  content: string;
  importance: number;
  /** Set when referenced files changed since the memory was recorded — the
   *  injector surfaces it so the model treats the memory with suspicion. */
  staleNote?: string;
}

/**
 * D1 (2/2) — optional LLM selective-recall pass applied to the proactive
 * `retrieve` result (keeps only items clearly ABOUT the task). Set via
 * `setRecallFilter` from the wiring layer where the pipeline resolver lives.
 * Must be FAIL-OPEN (return `items` on any trouble).
 */
export type RecallFilterFn = (taskText: string, items: RetrievedMemory[]) => Promise<RetrievedMemory[]>;

export interface MemoryRetrieverOptions {
  /** Items returned (and injected). Default 3. */
  topK?: number;
  /** Candidates fetched from hybrid search before re-ranking. Default max(topK*3, 10). */
  fetchK?: number;
  /** Skip retrieval for queries shorter than this (avoids noise). Default 4 —
   *  was 12, which silently dropped short-but-real user asks ("fix auth"). */
  minQueryChars?: number;
  /**
   * D1 — absolute floor on the blended relevance score. Candidates below it are
   * dropped BEFORE the topK slice, so a weak/tangential hit is never injected
   * just to fill the quota. Undefined = no floor (legacy behavior). Applies to
   * the proactive `retrieve` path only; `recall` (explicit intent) is untouched.
   */
  minRelevance?: number;
  /**
   * D1 — categories to recall MORE conservatively (CC: "be especially
   * conservative with user-profile / project-overview memories"). A candidate
   * whose category is in this set must clear `minRelevance × conservativeFactor`.
   * Only applies when `minRelevance` is set.
   */
  conservativeCategories?: ReadonlySet<string>;
  /** Multiplier on `minRelevance` for `conservativeCategories`. Default 1.5. */
  conservativeFactor?: number;
  /** Diagnostics sink for silent-skip paths (short query / zero hits). */
  log?: (event: 'skip_short_query' | 'zero_hits', data: Record<string, unknown>) => void;
}

/** Full-content row returned by the explicit `recall` path (recall_memory tool). */
export interface RecalledMemory extends RetrievedMemory {
  category?: string;
  source?: string;
}

// Decay/staleness scoring: the additive blend lives in scoring.ts (shared
// with AgentMemoryRetriever, now including a CATEGORY term so preferences/
// conventions outrank loose notes), then a MULTIPLICATIVE staleness discount
// scales the whole score, so a very-relevant but stale memory drops below a
// fresh one (the thesis: memory must expire).
const STALE_MAX = 0.5; // max trust discount when ALL referenced files changed
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const USE_SATURATION = 20; // access_count at which the "frequently useful" term ~saturates

export class MemoryRetriever {
  /** D1 (2/2) — optional LLM aboutness filter; null = off (structural floor only). */
  private recallFilter?: RecallFilterFn;

  constructor(
    private readonly search: SnapshotSearch,
    private readonly access: AccessMarker & Partial<StaleFilesBatch>,
    private readonly opts: MemoryRetrieverOptions = {},
  ) {}

  /** Install the LLM selective-recall filter (proactive `retrieve` only). */
  setRecallFilter(fn: RecallFilterFn): void {
    this.recallFilter = fn;
  }

  async retrieve(projectId: number, projectName: string, queryText: string): Promise<RetrievedMemory[]> {
    const q = queryText.trim();
    const minChars = this.opts.minQueryChars ?? 4;
    if (q.length < minChars) {
      this.opts.log?.('skip_short_query', { length: q.length, min: minChars });
      return [];
    }

    const topK = this.opts.topK ?? 3;
    const fetchK = this.opts.fetchK ?? Math.max(topK * 3, 10);

    const hits = await this.search.searchSnapshotsHybrid(projectId, projectName, q, fetchK);
    if (hits.length === 0) {
      this.opts.log?.('zero_hits', { query: q.slice(0, 80) });
      return [];
    }

    const top = this.applyRelevanceFloor(this.scoreHits(hits, projectId)).slice(0, topK);
    let items: RetrievedMemory[] = top.map((t) => ({
      id: String(t.snap.id),
      title: t.snap.title,
      content: t.snap.content,
      importance: clamp01(t.snap.importance ?? 0.5),
      staleNote: buildStaleNote(t.st?.stale),
    }));
    // D1 (2/2) — LLM aboutness pass (fail-open). Applied BEFORE markAccessed so
    // only the memories actually injected get their access bumped.
    if (this.recallFilter) {
      try {
        items = await this.recallFilter(q, items);
      } catch {
        /* fail-open — keep the unfiltered items */
      }
    }
    this.markAccessed(items.map((m) => Number(m.id)).filter((n) => Number.isFinite(n)));
    return items;
  }

  /**
   * D1 — drop candidates below the relevance floor (with a stricter bar for
   * conservative categories) BEFORE the topK slice. No-op when `minRelevance`
   * is unset → identical legacy behavior. The input is already score-sorted.
   */
  private applyRelevanceFloor(
    scored: Array<{ snap: ContextSnapshot; st?: { stale: string[]; total: number }; score: number }>,
  ): Array<{ snap: ContextSnapshot; st?: { stale: string[]; total: number }; score: number }> {
    const floor = this.opts.minRelevance;
    if (floor == null) return scored;
    const conservative = this.opts.conservativeCategories;
    const factor = this.opts.conservativeFactor ?? 1.5;
    return scored.filter((s) => {
      const cat = s.snap.category;
      const bar = conservative && cat && conservative.has(cat) ? floor * factor : floor;
      return s.score >= bar;
    });
  }

  /**
   * Explicit full-content recall — backs the `recall_memory` tool. No
   * min-query gate (an explicit call IS intent), wider fetch, and the result
   * carries category/source so the agent sees provenance. Marks access.
   */
  async recall(
    projectId: number,
    projectName: string,
    query: string,
    limit = 5,
  ): Promise<RecalledMemory[]> {
    const q = query.trim();
    if (!q) return [];
    const k = Math.max(1, Math.min(12, Math.floor(limit)));

    const hits = await this.search.searchSnapshotsHybrid(projectId, projectName, q, Math.max(k * 3, 15));
    if (hits.length === 0) {
      this.opts.log?.('zero_hits', { query: q.slice(0, 80), recall: true });
      return [];
    }

    const top = this.scoreHits(hits, projectId).slice(0, k);
    this.markAccessed(top.map((t) => t.snap.id));

    return top.map((t) => ({
      id: String(t.snap.id),
      title: t.snap.title,
      content: t.snap.content,
      category: t.snap.category,
      source: t.snap.source,
      importance: clamp01(t.snap.importance ?? 0.5),
      staleNote: buildStaleNote(t.st?.stale),
    }));
  }

  /**
   * Score = relevance × (importance + recency + frequency-of-use) × staleness
   * discount. Relevance (hybrid rank) still dominates first-order; the rest
   * breaks near-ties and lets a fresh memory beat a stale-but-relevant one.
   */
  private scoreHits(
    hits: ContextSnapshot[],
    projectId: number,
  ): Array<{ snap: ContextSnapshot; st?: { stale: string[]; total: number }; score: number }> {
    // Batched staleness over all candidates (one grouped query). Optional dep:
    // when absent (test fakes) the discount + note are simply skipped.
    let staleMap: Map<number, { stale: string[]; total: number }> | null = null;
    if (this.access.getStaleSnapshotFilesBatch) {
      try {
        staleMap = this.access.getStaleSnapshotFilesBatch(hits.map((h) => h.id), projectId);
      } catch {
        staleMap = null; // staleness is best-effort — never fail retrieval over it
      }
    }

    const now = Date.now();
    const scored = hits.map((snap, i) => {
      const imp = clamp01(snap.importance ?? 0.5);
      const ms = toMs(snap.last_accessed_at ?? snap.created_at);
      const rec = ms != null ? recencyDecay(ms, { halfLifeMs: RECENCY_HALF_LIFE_MS, now }) : 0;
      const use = clamp01(Math.log1p(snap.access_count ?? 0) / Math.log1p(USE_SATURATION));
      const st = staleMap?.get(snap.id);
      const staleMult = st && st.total > 0 ? 1 - STALE_MAX * Math.min(1, st.stale.length / st.total) : 1;
      const relevance = 1 / (i + 1);
      return {
        snap,
        st,
        score: blendedMemoryScore({
          relevance, importance: imp, recency: rec, usage: use,
          type: snap.category ?? 'note', staleMult,
        }),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  private markAccessed(ids: number[]): void {
    try {
      this.access.markSnapshotAccessed(ids);
    } catch {
      /* access bump is best-effort — never fail retrieval over it */
    }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/** Parse a SQLite `datetime('now')` string to epoch ms; null when unparseable. */
function toMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Human note for the injector when a memory's referenced files have changed. */
function buildStaleNote(stale: string[] | undefined): string | undefined {
  if (!stale || stale.length === 0) return undefined;
  const shown = stale.slice(0, 3).join(', ');
  const extra = stale.length > 3 ? ` (+${stale.length - 3} more)` : '';
  return `${shown}${extra} changed since recorded`;
}
