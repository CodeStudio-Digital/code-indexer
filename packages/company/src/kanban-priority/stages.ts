/**
 * Pipeline stages for kanban priority.
 *
 * All scorers are candidate-isolated. The `blocksOthers` and `blockedBy`
 * signals depend on the FULL candidate set so they're computed during the
 * Source step (cheaper than running multiple sequential passes).
 */
import type {
  Source,
  Filter,
  Scorer,
  Selector,
  CandidateResult,
  FilterResult,
  SelectResult,
} from '@mcp/candidate-pipeline';
import { weightedSum } from '@mcp/candidate-pipeline';
import {
  DEFAULT_WEIGHTS,
  type KanbanCandidate,
  type KanbanCardInput,
  type KanbanPriorityQuery,
} from './types.js';

// ─── Helpers ───────────────────────────────────────────────────────────

const TAG_IMPACT: Record<string, number> = {
  bug: 1.0,
  feature: 0.6,
  refactor: 0.4,
  documentation: 0.2,
};

function toCandidate(card: KanbanCardInput): KanbanCandidate {
  return {
    candidateId: String(card.id),
    card,
    signals: {},
    score: 0,
  };
}

function detectEffort(description: string): number {
  // Longer descriptions = more effort. Inverse-saturating curve:
  //   0 chars → 0, 800 chars → ~1.
  const len = description.length;
  return Math.min(1, len / 800);
}

function detectUrgency(card: KanbanCardInput, nowMs: number): number {
  // "Stalled" urgency: cards stuck in_progress/review for too long.
  if (card.column !== 'in_progress' && card.column !== 'review') return 0;
  const since = card.columnUpdatedAtMs ?? card.createdAtMs;
  if (since == null) return 0.3; // moderate when we don't know
  const ageHours = Math.max(0, (nowMs - since) / 3_600_000);
  // Saturate after 24 hours stalled.
  return Math.min(1, ageHours / 24);
}

// ─── Source ────────────────────────────────────────────────────────────

export class KanbanCardsSource implements Source<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'kanban_cards';
  enable(): boolean { return true; }
  async source(query: KanbanPriorityQuery): Promise<KanbanCandidate[]> {
    return query.cards.map(toCandidate);
  }
}

// ─── Filter — drop completed/archived cards from priority scoring ─────

export class ActiveColumnFilter implements Filter<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'active_columns';
  enable(): boolean { return true; }
  filter(_query: KanbanPriorityQuery, candidates: KanbanCandidate[]): FilterResult<KanbanCandidate> {
    const kept: KanbanCandidate[] = [];
    const removed: KanbanCandidate[] = [];
    for (const c of candidates) {
      if (c.card.column === 'done') removed.push(c);
      else kept.push(c);
    }
    return { kept, removed };
  }
}

// ─── Scorers ───────────────────────────────────────────────────────────

export class ImpactScorer implements Scorer<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'impact';
  enable(): boolean { return true; }
  async score(
    _query: KanbanPriorityQuery,
    candidates: readonly KanbanCandidate[],
  ): Promise<CandidateResult<KanbanCandidate>[]> {
    return candidates.map((c): CandidateResult<KanbanCandidate> => {
      const tagImpact = c.card.tag ? TAG_IMPACT[c.card.tag] ?? 0.5 : 0.5;
      return { ok: true, candidate: { ...c, signals: { ...c.signals, impact: tagImpact } } };
    });
  }
  update(c: KanbanCandidate, s: KanbanCandidate): void { c.signals = s.signals; }
}

export class EffortScorer implements Scorer<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'effort';
  enable(): boolean { return true; }
  async score(
    _query: KanbanPriorityQuery,
    candidates: readonly KanbanCandidate[],
  ): Promise<CandidateResult<KanbanCandidate>[]> {
    return candidates.map((c): CandidateResult<KanbanCandidate> => ({
      ok: true,
      candidate: { ...c, signals: { ...c.signals, effort: detectEffort(c.card.description) } },
    }));
  }
  update(c: KanbanCandidate, s: KanbanCandidate): void { c.signals = s.signals; }
}

export class BlocksOthersScorer implements Scorer<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'blocks_others';
  enable(): boolean { return true; }
  async score(
    _query: KanbanPriorityQuery,
    candidates: readonly KanbanCandidate[],
  ): Promise<CandidateResult<KanbanCandidate>[]> {
    return candidates.map((c): CandidateResult<KanbanCandidate> => {
      const count = c.card.blocks?.length ?? 0;
      return {
        ok: true,
        candidate: { ...c, signals: { ...c.signals, blocksOthers: Math.min(1, count / 3) } },
      };
    });
  }
  update(c: KanbanCandidate, s: KanbanCandidate): void { c.signals = s.signals; }
}

export class BlockedByScorer implements Scorer<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'blocked_by';
  enable(): boolean { return true; }
  async score(
    _query: KanbanPriorityQuery,
    candidates: readonly KanbanCandidate[],
  ): Promise<CandidateResult<KanbanCandidate>[]> {
    return candidates.map((c): CandidateResult<KanbanCandidate> => {
      const count = c.card.blockedBy?.length ?? 0;
      return {
        ok: true,
        candidate: { ...c, signals: { ...c.signals, blockedBy: Math.min(1, count / 2) } },
      };
    });
  }
  update(c: KanbanCandidate, s: KanbanCandidate): void { c.signals = s.signals; }
}

export class UrgencyScorer implements Scorer<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'urgency';
  enable(): boolean { return true; }
  async score(
    query: KanbanPriorityQuery,
    candidates: readonly KanbanCandidate[],
  ): Promise<CandidateResult<KanbanCandidate>[]> {
    const now = query.nowMs ?? Date.now();
    return candidates.map((c): CandidateResult<KanbanCandidate> => ({
      ok: true,
      candidate: { ...c, signals: { ...c.signals, urgency: detectUrgency(c.card, now) } },
    }));
  }
  update(c: KanbanCandidate, s: KanbanCandidate): void { c.signals = s.signals; }
}

export class RoleAvailabilityScorer implements Scorer<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'role_availability';
  enable(query: KanbanPriorityQuery): boolean { return (query.idleRoles?.length ?? 0) > 0; }
  async score(
    query: KanbanPriorityQuery,
    candidates: readonly KanbanCandidate[],
  ): Promise<CandidateResult<KanbanCandidate>[]> {
    const idle = new Set(query.idleRoles ?? []);
    return candidates.map((c): CandidateResult<KanbanCandidate> => {
      const roles = c.card.assignedRoles ?? [];
      const hasIdle = roles.some((r) => idle.has(r));
      return {
        ok: true,
        candidate: { ...c, signals: { ...c.signals, roleAvailability: hasIdle ? 1 : 0 } },
      };
    });
  }
  update(c: KanbanCandidate, s: KanbanCandidate): void { c.signals = s.signals; }
}

export class WeightedFusionScorer implements Scorer<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'weighted_fusion';
  enable(): boolean { return true; }
  async score(
    query: KanbanPriorityQuery,
    candidates: readonly KanbanCandidate[],
  ): Promise<CandidateResult<KanbanCandidate>[]> {
    const w = query.weights ?? DEFAULT_WEIGHTS;
    return candidates.map((c): CandidateResult<KanbanCandidate> => {
      const ws = weightedSum([
        { name: 'impact',           value: c.signals.impact           ?? 0, weight: w.impact },
        { name: 'effort',           value: c.signals.effort           ?? 0, weight: w.effort },
        { name: 'blocksOthers',     value: c.signals.blocksOthers     ?? 0, weight: w.blocksOthers },
        { name: 'urgency',          value: c.signals.urgency          ?? 0, weight: w.urgency },
        { name: 'roleAvailability', value: c.signals.roleAvailability ?? 0, weight: w.roleAvailability },
        { name: 'blockedBy',        value: c.signals.blockedBy        ?? 0, weight: w.blockedBy },
      ]);
      return { ok: true, candidate: { ...c, score: ws.score } };
    });
  }
  update(c: KanbanCandidate, s: KanbanCandidate): void { c.score = s.score; }
}

// ─── Selector ──────────────────────────────────────────────────────────

export class PrioritySortSelector implements Selector<KanbanPriorityQuery, KanbanCandidate> {
  readonly name = 'priority_sort';
  enable(): boolean { return true; }
  size(): number | undefined { return undefined; }
  score(c: KanbanCandidate): number { return c.score; }
  select(query: KanbanPriorityQuery, candidates: KanbanCandidate[]): SelectResult<KanbanCandidate> {
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const k = query.k;
    if (k == null || k <= 0) return { selected: sorted, nonSelected: [] };
    return { selected: sorted.slice(0, k), nonSelected: sorted.slice(k) };
  }
}
