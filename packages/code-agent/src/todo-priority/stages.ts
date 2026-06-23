/**
 * Pipeline stages for todo priority.
 *
 * All scorers are candidate-isolated (each todo scored independently of
 * the others) EXCEPT the dependency-graph hydrator which is intentionally
 * a single batch step. After hydration, scorers can read the precomputed
 * adjacency without recomputing it per item.
 */
import type {
  Source,
  Hydrator,
  Filter,
  Scorer,
  Selector,
  CandidateResult,
  FilterResult,
  SelectResult,
} from '@mcp/candidate-pipeline';
import { weightedSum } from '@mcp/candidate-pipeline';
import {
  buildAdjacency,
  detectImpact,
  detectQuickWin,
  detectUrgency,
  toCandidate,
} from './helpers.js';
import {
  DEFAULT_WEIGHTS,
  type TodoCandidate,
  type TodoPriorityQuery,
} from './types.js';

// ─── Source ─────────────────────────────────────────────────────────────

export class TodoListSource implements Source<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'todo_list';
  enable(): boolean { return true; }
  async source(query: TodoPriorityQuery): Promise<TodoCandidate[]> {
    return query.items.map(toCandidate);
  }
}

// ─── Hydrator: dependency graph ─────────────────────────────────────────

export class DependencyGraphHydrator implements Hydrator<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'dependency_graph';
  enable(): boolean { return true; }
  async hydrate(
    query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    const adj = buildAdjacency(query.items);
    return candidates.map((c): CandidateResult<TodoCandidate> => ({
      ok: true,
      candidate: {
        ...c,
        blockedByThis: adj.blockedByThis.get(c.item.id) ?? [],
        blockedBy: adj.blockedBy.get(c.item.id) ?? [],
      },
    }));
  }
  update(c: TodoCandidate, h: TodoCandidate): void {
    c.blockedByThis = h.blockedByThis;
    c.blockedBy = h.blockedBy;
  }
}

// ─── Filter: status partition ───────────────────────────────────────────
//
// The pipeline only RESCORES pending items. `in_progress` is pinned to
// the top of the output, `completed` to the bottom. We achieve this by
// marking them as "frozen" via a synthetic signal and letting the selector
// handle the final ordering.
//
// (We don't actually drop them in the filter — the selector needs to keep
// them in the output, just at fixed positions.)

// ─── Scorers ────────────────────────────────────────────────────────────

export class ImpactScorer implements Scorer<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'impact';
  enable(): boolean { return true; }
  async score(
    _query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    return candidates.map((c): CandidateResult<TodoCandidate> => ({
      ok: true,
      candidate: {
        ...c,
        signals: { ...c.signals, impact: detectImpact(c.item.content) },
      },
    }));
  }
  update(c: TodoCandidate, s: TodoCandidate): void { c.signals = s.signals; }
}

export class BlocksOthersScorer implements Scorer<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'blocks_others';
  enable(): boolean { return true; }
  async score(
    _query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    return candidates.map((c): CandidateResult<TodoCandidate> => {
      // Saturate at 3 blocked items.
      const blocks = c.blockedByThis.length;
      const value = blocks === 0 ? 0 : Math.min(1, blocks / 3);
      return { ok: true, candidate: { ...c, signals: { ...c.signals, blocksOthers: value } } };
    });
  }
  update(c: TodoCandidate, s: TodoCandidate): void { c.signals = s.signals; }
}

export class UrgencyScorer implements Scorer<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'urgency';
  enable(): boolean { return true; }
  async score(
    query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    const now = query.nowMs ?? Date.now();
    return candidates.map((c): CandidateResult<TodoCandidate> => ({
      ok: true,
      candidate: {
        ...c,
        signals: { ...c.signals, urgency: detectUrgency(c.item, now) },
      },
    }));
  }
  update(c: TodoCandidate, s: TodoCandidate): void { c.signals = s.signals; }
}

export class EffortScorer implements Scorer<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'effort';
  enable(): boolean { return true; }
  async score(
    _query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    return candidates.map((c): CandidateResult<TodoCandidate> => ({
      ok: true,
      candidate: {
        ...c,
        signals: { ...c.signals, effort: detectQuickWin(c.item.content) },
      },
    }));
  }
  update(c: TodoCandidate, s: TodoCandidate): void { c.signals = s.signals; }
}

/** Bonus when an item's deps are already resolved (i.e. `blockedBy` is empty). */
export class DependencyMetScorer implements Scorer<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'dependency_met';
  enable(): boolean { return true; }
  async score(
    _query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    return candidates.map((c): CandidateResult<TodoCandidate> => {
      const met = c.blockedBy.length === 0 ? 1 : 0;
      return { ok: true, candidate: { ...c, signals: { ...c.signals, dependencyMet: met } } };
    });
  }
  update(c: TodoCandidate, s: TodoCandidate): void { c.signals = s.signals; }
}

/** Penalty when an item is BLOCKED by a pending dep. */
export class BlockedScorer implements Scorer<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'blocked';
  enable(): boolean { return true; }
  async score(
    _query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    return candidates.map((c): CandidateResult<TodoCandidate> => {
      const blocked = c.blockedBy.length === 0 ? 0 : Math.min(1, c.blockedBy.length / 2);
      return { ok: true, candidate: { ...c, signals: { ...c.signals, blocked } } };
    });
  }
  update(c: TodoCandidate, s: TodoCandidate): void { c.signals = s.signals; }
}

export class WeightedFusionScorer implements Scorer<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'weighted_fusion';
  enable(): boolean { return true; }
  async score(
    query: TodoPriorityQuery,
    candidates: readonly TodoCandidate[],
  ): Promise<CandidateResult<TodoCandidate>[]> {
    const w = query.weights ?? DEFAULT_WEIGHTS;
    return candidates.map((c): CandidateResult<TodoCandidate> => {
      const ws = weightedSum([
        { name: 'impact',        value: c.signals.impact        ?? 0, weight: w.impact },
        { name: 'blocksOthers',  value: c.signals.blocksOthers  ?? 0, weight: w.blocksOthers },
        { name: 'urgency',       value: c.signals.urgency       ?? 0, weight: w.urgency },
        { name: 'effort',        value: c.signals.effort        ?? 0, weight: w.effort },
        { name: 'dependencyMet', value: c.signals.dependencyMet ?? 0, weight: w.dependencyMet },
        { name: 'blocked',       value: c.signals.blocked       ?? 0, weight: w.blocked },
      ]);
      return { ok: true, candidate: { ...c, score: ws.score } };
    });
  }
  update(c: TodoCandidate, s: TodoCandidate): void { c.score = s.score; }
}

// ─── Selector — status-aware ordering ───────────────────────────────────
//
// Output layout: [in_progress (original order)] [pending (sorted by score
// desc)] [completed (original order)]. The selector never DROPS anything
// — it only re-arranges.

export class StatusAwareSelector implements Selector<TodoPriorityQuery, TodoCandidate> {
  readonly name = 'status_aware';
  enable(): boolean { return true; }
  size(): number | undefined { return undefined; }
  score(c: TodoCandidate): number { return c.score; }
  select(_query: TodoPriorityQuery, candidates: TodoCandidate[]): SelectResult<TodoCandidate> {
    const inProgress = candidates.filter((c) => c.item.status === 'in_progress');
    const completed  = candidates.filter((c) => c.item.status === 'completed');
    const pending    = candidates
      .filter((c) => c.item.status === 'pending')
      .sort((a, b) => b.score - a.score);
    return {
      selected: [...inProgress, ...pending, ...completed],
      nonSelected: [],
    };
  }
}
