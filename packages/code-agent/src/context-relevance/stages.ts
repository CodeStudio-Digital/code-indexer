/**
 * Pipeline stages for context relevance.
 */
import type {
  QueryHydrator,
  Source,
  Hydrator,
  Filter,
  Scorer,
  Selector,
  CandidateResult,
  FilterResult,
  SelectResult,
} from '@mcp/candidate-pipeline';
import {
  assertEmbeddingFingerprint,
  cosineSimilarity,
  recencyDecay,
  resolveEmbeddingFingerprint,
  weightedSum,
} from '@mcp/candidate-pipeline';
import { detectDecisionMarker, detectInfoDensity, toCandidate } from './helpers.js';
import {
  DEFAULT_PRESERVE_RECENT_TURNS,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  DEFAULT_WEIGHTS,
  type ContextRelevanceQuery,
  type MessageCandidate,
  type SessionMessage,
} from './types.js';

export interface EmbeddingFn {
  (text: string): Promise<Float32Array>;
  readonly fingerprint?: () => string;
}

// ────────────────────────────────────────────────────────────────────────
// Query hydrator
// ────────────────────────────────────────────────────────────────────────

export class TaskEmbeddingHydrator implements QueryHydrator<ContextRelevanceQuery> {
  readonly name = 'task_embedding';
  constructor(private embed: EmbeddingFn) {}
  enable(query: ContextRelevanceQuery): boolean {
    return query.taskText.trim().length > 0 && (!query.taskEmbedding || !query.embeddingFingerprint);
  }
  async hydrate(query: ContextRelevanceQuery): Promise<Partial<ContextRelevanceQuery>> {
    const embeddingFingerprint = resolveEmbeddingFingerprint(this.embed);
    const taskEmbedding = await this.embed(query.taskText);
    assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
    return { taskEmbedding, embeddingFingerprint };
  }
  update(query: ContextRelevanceQuery, partial: Partial<ContextRelevanceQuery>): void {
    if (partial.taskEmbedding) query.taskEmbedding = partial.taskEmbedding;
    if (partial.embeddingFingerprint) query.embeddingFingerprint = partial.embeddingFingerprint;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Source
// ────────────────────────────────────────────────────────────────────────

export class SessionMessagesSource implements Source<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'session_messages';
  constructor(private getMessages: () => SessionMessage[]) {}
  enable(): boolean { return true; }
  async source(): Promise<MessageCandidate[]> {
    return this.getMessages().map(toCandidate);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Hydrators
// ────────────────────────────────────────────────────────────────────────

export interface MessageEmbeddingStore {
  get(messageId: string, embeddingFingerprint: string): Float32Array | undefined;
  set(messageId: string, embeddingFingerprint: string, embedding: Float32Array): void;
}

export class MessageEmbeddingHydrator implements Hydrator<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'message_embedding';
  constructor(
    private embed: EmbeddingFn,
    private store: MessageEmbeddingStore,
  ) {}
  enable(): boolean { return true; }
  async hydrate(
    query: ContextRelevanceQuery,
    candidates: readonly MessageCandidate[],
  ): Promise<CandidateResult<MessageCandidate>[]> {
    const embeddingFingerprint = query.embeddingFingerprint ?? resolveEmbeddingFingerprint(this.embed);
    assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
    return Promise.all(
      candidates.map(async (c): Promise<CandidateResult<MessageCandidate>> => {
        const cached = this.store.get(c.message.id, embeddingFingerprint);
        if (cached) {
          return { ok: true, candidate: { ...c, embedding: cached } };
        }
        try {
          const embedding = await this.embed(c.message.text);
          assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
          this.store.set(c.message.id, embeddingFingerprint, embedding);
          return { ok: true, candidate: { ...c, embedding } };
        } catch (e) {
          return { ok: false, candidateId: c.candidateId, error: (e as Error).message };
        }
      }),
    );
  }
  update(candidate: MessageCandidate, hydrated: MessageCandidate): void {
    candidate.embedding = hydrated.embedding;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Filters: guards that pin messages so they're never dropped.
// ────────────────────────────────────────────────────────────────────────

/** System messages are always pinned. */
export class SystemMessageGuard implements Filter<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'system_guard';
  enable(): boolean { return true; }
  filter(_query: ContextRelevanceQuery, candidates: MessageCandidate[]): FilterResult<MessageCandidate> {
    const kept = candidates.map((c) => c.message.role === 'system' ? { ...c, pinned: true } : c);
    return { kept, removed: [] };
  }
}

/** Last N turns are always pinned. */
export class RecentTurnsGuard implements Filter<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'recent_turns_guard';
  enable(): boolean { return true; }
  filter(query: ContextRelevanceQuery, candidates: MessageCandidate[]): FilterResult<MessageCandidate> {
    const recentN = query.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS;
    if (candidates.length <= recentN) {
      return { kept: candidates.map((c) => ({ ...c, pinned: true })), removed: [] };
    }
    // Pin the LAST N entries (assumed sorted oldest→newest by caller).
    const kept = candidates.map((c, i) =>
      i >= candidates.length - recentN ? { ...c, pinned: true } : c,
    );
    return { kept, removed: [] };
  }
}

/**
 * Atomic block coherence: if any message in a block is pinned, pin them all.
 * Prevents the budget selector from breaking a user→assistant→tool_result
 * triplet.
 */
export class AtomicBlockFilter implements Filter<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'atomic_block_filter';
  enable(): boolean { return true; }
  filter(_query: ContextRelevanceQuery, candidates: MessageCandidate[]): FilterResult<MessageCandidate> {
    // First pass: find pinned blocks.
    const pinnedBlocks = new Set<string>();
    for (const c of candidates) {
      const bid = c.message.atomicBlockId;
      if (bid && c.pinned) pinnedBlocks.add(bid);
    }
    // Second pass: propagate pin to all members of a pinned block.
    const kept = candidates.map((c) => {
      const bid = c.message.atomicBlockId;
      if (bid && pinnedBlocks.has(bid)) return { ...c, pinned: true };
      return c;
    });
    return { kept, removed: [] };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Scorers — candidate-isolation friendly (each message scored
// independently of the others), so the scores are deterministic and
// cacheable per (queryHash, messageId).
// ────────────────────────────────────────────────────────────────────────

export class TaskAffinityScorer implements Scorer<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'task_affinity';
  enable(query: ContextRelevanceQuery): boolean { return !!query.taskEmbedding; }
  async score(
    query: ContextRelevanceQuery,
    candidates: readonly MessageCandidate[],
  ): Promise<CandidateResult<MessageCandidate>[]> {
    const q = query.taskEmbedding!;
    return candidates.map((c): CandidateResult<MessageCandidate> => {
      const sim = c.embedding ? cosineSimilarity(q, c.embedding) : 0;
      return { ok: true, candidate: { ...c, signals: { ...c.signals, taskAffinity: sim } } };
    });
  }
  update(candidate: MessageCandidate, scored: MessageCandidate): void {
    candidate.signals = scored.signals;
  }
}

export class RecencyScorer implements Scorer<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'recency';
  enable(): boolean { return true; }
  async score(
    query: ContextRelevanceQuery,
    candidates: readonly MessageCandidate[],
  ): Promise<CandidateResult<MessageCandidate>[]> {
    const halfLife = query.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
    return candidates.map((c): CandidateResult<MessageCandidate> => {
      const decay = recencyDecay(c.message.createdAtMs, { halfLifeMs: halfLife });
      return { ok: true, candidate: { ...c, signals: { ...c.signals, recency: decay } } };
    });
  }
  update(candidate: MessageCandidate, scored: MessageCandidate): void {
    candidate.signals = scored.signals;
  }
}

export class InfoDensityScorer implements Scorer<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'info_density';
  enable(): boolean { return true; }
  async score(
    _query: ContextRelevanceQuery,
    candidates: readonly MessageCandidate[],
  ): Promise<CandidateResult<MessageCandidate>[]> {
    return candidates.map((c): CandidateResult<MessageCandidate> => ({
      ok: true,
      candidate: { ...c, signals: { ...c.signals, infoDensity: detectInfoDensity(c.message) } },
    }));
  }
  update(candidate: MessageCandidate, scored: MessageCandidate): void {
    candidate.signals = scored.signals;
  }
}

export class DecisionMarkerScorer implements Scorer<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'decision_marker';
  enable(): boolean { return true; }
  async score(
    _query: ContextRelevanceQuery,
    candidates: readonly MessageCandidate[],
  ): Promise<CandidateResult<MessageCandidate>[]> {
    return candidates.map((c): CandidateResult<MessageCandidate> => ({
      ok: true,
      candidate: { ...c, signals: { ...c.signals, decisionMarker: detectDecisionMarker(c.message.text) } },
    }));
  }
  update(candidate: MessageCandidate, scored: MessageCandidate): void {
    candidate.signals = scored.signals;
  }
}

export class WeightedFusionScorer implements Scorer<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'weighted_fusion';
  enable(): boolean { return true; }
  async score(
    query: ContextRelevanceQuery,
    candidates: readonly MessageCandidate[],
  ): Promise<CandidateResult<MessageCandidate>[]> {
    const w = query.weights ?? DEFAULT_WEIGHTS;
    return candidates.map((c): CandidateResult<MessageCandidate> => {
      const ws = weightedSum([
        { name: 'taskAffinity',   value: c.signals.taskAffinity   ?? 0, weight: w.taskAffinity },
        { name: 'recency',        value: c.signals.recency        ?? 0, weight: w.recency },
        { name: 'infoDensity',    value: c.signals.infoDensity    ?? 0, weight: w.infoDensity },
        { name: 'decisionMarker', value: c.signals.decisionMarker ?? 0, weight: w.decisionMarker },
      ]);
      return { ok: true, candidate: { ...c, score: ws.score } };
    });
  }
  update(candidate: MessageCandidate, scored: MessageCandidate): void {
    candidate.score = scored.score;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Selector — budget-aware. Always include pinned + atomic-block-coherent
// messages, then fill the remaining budget with the highest-scoring rest.
// ────────────────────────────────────────────────────────────────────────

export class BudgetAwareSelector implements Selector<ContextRelevanceQuery, MessageCandidate> {
  readonly name = 'budget_aware';
  enable(): boolean { return true; }
  size(): number | undefined { return undefined; } // budget, not count
  score(c: MessageCandidate): number { return c.score; }
  select(query: ContextRelevanceQuery, candidates: MessageCandidate[]): SelectResult<MessageCandidate> {
    const pinned = candidates.filter((c) => c.pinned);
    const droppable = candidates.filter((c) => !c.pinned);
    const pinnedTokens = pinned.reduce((acc, c) => acc + c.tokens, 0);
    let remaining = Math.max(0, query.tokenBudget - pinnedTokens);

    // Pinned messages always go in. They might exceed the budget — that's
    // okay; we still respect "never drop a pinned message".
    const selected = new Set<string>(pinned.map((c) => c.message.id));

    // Sort droppable by score desc, then greedily fit by tokens.
    const ranked = [...droppable].sort((a, b) => b.score - a.score);
    for (const c of ranked) {
      if (c.tokens <= remaining) {
        selected.add(c.message.id);
        remaining -= c.tokens;
      }
    }

    // Reorder selected to preserve original message order (callers feed
    // these back to the model in chronological sequence).
    const selectedArr = candidates.filter((c) => selected.has(c.message.id));
    const nonSelected = candidates.filter((c) => !selected.has(c.message.id));
    return { selected: selectedArr, nonSelected };
  }
}
