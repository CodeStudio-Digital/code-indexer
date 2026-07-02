/**
 * Memory scoring — the shared blend both retrievers (agent_memory + legacy
 * snapshots) use to rank candidates, now with a CATEGORY term.
 *
 * Why: without it, a loose `note` with good lexical overlap outranks a
 * `preference`/`convention` — exactly backwards for the product goal
 * ("adhere to the user's style and the project's conventions"). The additive
 * block still sums to 1.0 so scores stay comparable with the old formula.
 *
 * Pure module (no DB, no LLM) — unit-testable in isolation. The turn-1 index
 * ranking keeps a local mirror of these weights in store/db/agent-memory.ts
 * (store cannot import services).
 */

/** Effectiveness-ordered weight per memory type/category (0..1). */
export const CATEGORY_WEIGHT: Record<string, number> = {
  // agent_memory types
  preference: 1.0,
  convention: 0.9,
  gotcha: 0.8,
  decision: 0.75,
  procedure: 0.7,
  architecture: 0.55,
  pattern: 0.5,
  external_pointer: 0.4,
  note: 0.25,
  // legacy snapshot categories that don't overlap the closed types
  feedback: 1.0,
  user: 0.95,
  todo: 0.3,
};

export const DEFAULT_CATEGORY_WEIGHT = 0.5;

/** Pins (importance ≥ this) skip the minRelevance floor — the user asked. */
export const PIN_IMPORTANCE = 0.9;

export interface MemoryScoreParts {
  /** Rank-derived relevance from hybrid search (1/(rank+1)). */
  relevance: number;
  /** Stored importance, 0..1. */
  importance: number;
  /** Recency decay, 0..1. */
  recency: number;
  /** Usage signal (log-saturated access count), 0..1. */
  usage: number;
  /** Memory type/category — looked up in CATEGORY_WEIGHT. */
  type: string;
  /** Staleness multiplier, 0..1 (1 = fresh). */
  staleMult: number;
}

const W_BASE = 0.35;
const W_IMP = 0.25;
const W_REC = 0.15;
const W_USE = 0.10;
const W_CAT = 0.15;

export function blendedMemoryScore(p: MemoryScoreParts): number {
  const catW = CATEGORY_WEIGHT[p.type] ?? DEFAULT_CATEGORY_WEIGHT;
  return (
    p.relevance *
    (W_BASE + W_IMP * p.importance + W_REC * p.recency + W_USE * p.usage + W_CAT * catW) *
    p.staleMult
  );
}

/**
 * Greedy diversity pass over a score-sorted list: cap how many items of the
 * SAME type make the cut, so the 3 injected memories are never 3 `procedure`s
 * while a relevant `convention` sits at rank 4. Preserves order; overflow
 * items are appended after the diverse picks (they may still land within a
 * larger topK).
 */
export function diversify<T extends { type: string }>(scored: T[], maxPerType = 2): T[] {
  const kept: T[] = [];
  const overflow: T[] = [];
  const perType = new Map<string, number>();
  for (const item of scored) {
    const n = perType.get(item.type) ?? 0;
    if (n < maxPerType) {
      kept.push(item);
      perType.set(item.type, n + 1);
    } else {
      overflow.push(item);
    }
  }
  return kept.concat(overflow);
}
