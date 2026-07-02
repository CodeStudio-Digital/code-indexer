import type { CodeIndexDB } from '@mcp/store/db.js';
import type { AgentMemoryScope, AgentMemoryType } from '@mcp/shared/types.js';
import { recencyDecay } from '@mcp/candidate-pipeline';
import type { AgentMemoryService } from './agent-memory-service.js';
import type { RecallFilterFn, RecalledMemory, RetrievedMemory } from './retriever.js';
import { blendedMemoryScore, diversify, PIN_IMPORTANCE } from './scoring.js';

/**
 * Retrieves relevant Agent Memory (the dedicated `agent_memory` table) for the
 * agent's current task — the read counterpart to {@link AgentMemoryService}.
 * SEPARATE from the snapshot-backed {@link MemoryRetriever}; this one never
 * touches snapshots.
 *
 * Candidates come pre-ranked from the hybrid (FTS + vector RRF) search; on top
 * of that we blend stored importance, recency, frequency-of-use and a staleness
 * discount, then (D1) apply a relevance floor and an optional LLM aboutness
 * filter — "if unsure, don't include it". The floor is applied to the BLENDED
 * score, never to the raw RRF rank (R5: RRF is not a calibrated relevance).
 */

const STALE_MAX = 0.5; // max trust discount when ALL referenced files changed
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const USE_SATURATION = 20;

export interface AgentMemoryRetrieverOptions {
  /** Items returned (and injected). Default 3. */
  topK?: number;
  /** Candidates fetched from hybrid search before re-ranking. Default max(topK*3, 10). */
  fetchK?: number;
  /** Skip proactive retrieval for queries shorter than this. Default 4. */
  minQueryChars?: number;
  /** Absolute floor on the blended score; weak hits are dropped before the topK
   *  slice instead of filling the quota. Undefined = no floor. */
  minRelevance?: number;
  /** Types recalled MORE conservatively (e.g. broad `preference`): must clear
   *  `minRelevance × conservativeFactor`. Only applies when `minRelevance` set. */
  conservativeTypes?: ReadonlySet<string>;
  conservativeFactor?: number;
  log?: (event: 'skip_short_query' | 'zero_hits', data: Record<string, unknown>) => void;
}

interface Scored {
  row: import('@mcp/shared/types.js').AgentMemoryRow & { score?: number };
  stale?: string[];
  type: string;
  score: number;
}

export class AgentMemoryRetriever {
  private recallFilter?: RecallFilterFn;

  constructor(
    private readonly service: AgentMemoryService,
    private readonly db: CodeIndexDB,
    private readonly opts: AgentMemoryRetrieverOptions = {},
  ) {}

  /** Install the LLM selective-recall filter (proactive `retrieve` only). */
  setRecallFilter(fn: RecallFilterFn): void {
    this.recallFilter = fn;
  }

  /** Proactive retrieval for injection. Marks access only on the kept items. */
  async retrieve(
    scope: AgentMemoryScope,
    projectId: number,
    queryText: string,
    type?: AgentMemoryType,
  ): Promise<RetrievedMemory[]> {
    const q = queryText.trim();
    const minChars = this.opts.minQueryChars ?? 4;
    if (q.length < minChars) {
      this.opts.log?.('skip_short_query', { length: q.length, min: minChars });
      return [];
    }
    const topK = this.opts.topK ?? 3;
    const fetchK = this.opts.fetchK ?? Math.max(topK * 3, 10);

    const hits = await this.service.search(scope, projectId, q, fetchK, type);
    if (hits.length === 0) {
      this.opts.log?.('zero_hits', { query: q.slice(0, 80) });
      return [];
    }

    // Floor the full candidate set, diversify (≤2 per type in the head so the
    // injected trio is never monotype), then map to RetrievedMemory.
    let candidates: RetrievedMemory[] = diversify(this.applyFloor(this.scoreHits(hits))).map((t) => ({
      id: String(t.row.id),
      title: t.row.name,
      content: t.row.content,
      importance: clamp01(t.row.importance ?? 0.5),
      staleNote: buildStaleNote(t.stale),
    }));
    // LLM aboutness pass (fail-open) — only worth a (paid) call when there are
    // MORE candidates than we'll keep, i.e. something to actually discriminate.
    if (this.recallFilter && candidates.length > topK) {
      try {
        candidates = await this.recallFilter(q, candidates);
      } catch {
        /* fail-open — keep the unfiltered candidates */
      }
    }
    const items = candidates.slice(0, topK);
    // Mark access only on the items actually injected.
    this.markAccessed(items.map((m) => Number(m.id)).filter((n) => Number.isFinite(n)));
    return items;
  }

  /** Explicit full-content recall — backs `recall_memory(mode:'search')`. No
   *  min-query gate (an explicit call IS intent); carries type/source provenance. */
  async recall(
    scope: AgentMemoryScope,
    projectId: number,
    query: string,
    limit = 5,
    type?: AgentMemoryType,
  ): Promise<RecalledMemory[]> {
    const q = query.trim();
    if (!q) return [];
    const k = Math.max(1, Math.min(12, Math.floor(limit)));
    const hits = await this.service.search(scope, projectId, q, Math.max(k * 3, 15), type);
    if (hits.length === 0) {
      this.opts.log?.('zero_hits', { query: q.slice(0, 80), recall: true });
      return [];
    }
    const top = this.scoreHits(hits).slice(0, k);
    this.markAccessed(top.map((t) => t.row.id));
    return top.map((t) => ({
      id: String(t.row.id),
      title: t.row.name,
      content: t.row.content,
      category: t.type,
      source: t.row.source,
      importance: clamp01(t.row.importance ?? 0.5),
      staleNote: buildStaleNote(t.stale),
    }));
  }

  private scoreHits(
    hits: Array<import('@mcp/shared/types.js').AgentMemoryRow & { score?: number }>,
  ): Scored[] {
    let staleMap: Map<number, { stale: string[]; total: number }> | null = null;
    try {
      staleMap = this.db.getAgentMemoryStaleBatch(hits.map((h) => h.id));
    } catch {
      staleMap = null; // staleness is best-effort
    }
    const now = Date.now();
    const scored: Scored[] = hits.map((row, i) => {
      const imp = clamp01(row.importance ?? 0.5);
      const ms = toMs(row.last_accessed_at ?? row.created_at);
      const rec = ms != null ? recencyDecay(ms, { halfLifeMs: RECENCY_HALF_LIFE_MS, now }) : 0;
      const use = clamp01(Math.log1p(row.access_count ?? 0) / Math.log1p(USE_SATURATION));
      const st = staleMap?.get(row.id);
      const staleMult =
        st && st.total > 0 ? 1 - STALE_MAX * Math.min(1, st.stale.length / st.total) : 1;
      const relevance = 1 / (i + 1);
      return {
        row,
        stale: st?.stale,
        type: row.type,
        score: blendedMemoryScore({
          relevance, importance: imp, recency: rec, usage: use, type: row.type, staleMult,
        }),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  private applyFloor(scored: Scored[]): Scored[] {
    const floor = this.opts.minRelevance;
    if (floor == null) return scored;
    const conservative = this.opts.conservativeTypes;
    const factor = this.opts.conservativeFactor ?? 1.5;
    return scored.filter((s) => {
      // Pins are user intent — never floored out.
      if ((s.row.importance ?? 0) >= PIN_IMPORTANCE) return true;
      const bar = conservative && conservative.has(s.type) ? floor * factor : floor;
      return s.score >= bar;
    });
  }

  private markAccessed(ids: number[]): void {
    try {
      this.db.bumpAgentMemoryAccess(ids);
    } catch {
      /* best-effort */
    }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function toMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function buildStaleNote(stale: string[] | undefined): string | undefined {
  if (!stale || stale.length === 0) return undefined;
  const shown = stale.slice(0, 3).join(', ');
  const extra = stale.length > 3 ? ` (+${stale.length - 3} more)` : '';
  return `${shown}${extra} changed since recorded`;
}
