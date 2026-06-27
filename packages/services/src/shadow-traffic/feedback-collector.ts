/**
 * Counterfactual feedback collector — backfills `true_outcome_json` on
 * pending counterfactual rows based on observed runtime events.
 *
 * Pattern: shadow rows are inserted at decision time with `production_choice`
 * and `shadow_prediction`. Later, the system observes what actually happened
 * (the master spawned which role, the tool that ran first, the card that
 * moved to done) — that's the "true outcome". The collector matches the
 * recent pending counterfactual rows to this outcome and records it.
 *
 * Why a separate service: shadow traffic produces predictions but doesn't
 * know what the "right answer" is. The truth emerges from later signals
 * (user behavior, master decisions, downstream metrics). Decoupling
 * outcome-recording from prediction-recording lets each side evolve
 * independently.
 */
import type { CounterfactualLogRow, CounterfactualLogStore } from '@mcp/store/counterfactual-log-store.js';

/**
 * Per-pipeline matcher — given recent pending rows + the observed
 * outcome, return the rows that should be backfilled with what.
 *
 * Returning an empty array is fine — it means "no rows matched the
 * observation; come back when we see the next event".
 */
export interface OutcomeMatcher<O> {
  /** Pipeline name this matcher handles, e.g. 'tool_selection'. */
  readonly pipelineName: string;
  /**
   * Maximum age of pending rows to consider, in ms. Rows older than this
   * are deemed too stale to attribute to the observed outcome.
   */
  readonly maxAgeMs: number;
  /**
   * Decide which pending row (if any) the outcome resolves, and what
   * to record. Implementors typically:
   *   1. Filter `pending` by some criteria (session id, query_hash, ...).
   *   2. Compute `true_outcome` based on the observed event.
   *   3. Optionally compute `outcome_confidence` (1.0 when certain).
   */
  match(
    observed: O,
    pending: CounterfactualLogRow[],
  ): Array<{ id: number; true_outcome: unknown; outcome_confidence?: number }>;
}

export interface FeedbackCollectorConfig {
  store: CounterfactualLogStore;
  /** Per-pipeline matchers. The collector dispatches by `pipelineName`. */
  matchers: OutcomeMatcher<unknown>[];
  /** Cap on pending rows fetched per match cycle. */
  pendingLimit?: number;
  /** Optional override of Date.now() (tests). */
  now?: () => number;
}

export class FeedbackCollector {
  private readonly cfg: Required<FeedbackCollectorConfig>;
  private readonly matchersByPipeline = new Map<string, OutcomeMatcher<unknown>>();
  private totalBackfilled = 0;

  constructor(cfg: FeedbackCollectorConfig) {
    this.cfg = {
      store: cfg.store,
      matchers: cfg.matchers,
      pendingLimit: cfg.pendingLimit ?? 200,
      now: cfg.now ?? Date.now,
    };
    for (const m of cfg.matchers) {
      this.matchersByPipeline.set(m.pipelineName, m);
    }
  }

  /**
   * Process one observed event. The matcher for `pipelineName` is
   * consulted; any matched rows have their outcomes recorded.
   *
   * Returns the number of rows successfully backfilled.
   */
  observe<O>(pipelineName: string, observed: O): number {
    const matcher = this.matchersByPipeline.get(pipelineName);
    if (!matcher) return 0;

    // Pull pending rows; drop stale ones early.
    const allPending = this.cfg.store.listPending({
      pipelineName,
      limit: this.cfg.pendingLimit,
    });
    const cutoff = this.cfg.now() - matcher.maxAgeMs;
    const fresh = allPending.filter((r) => {
      const created = new Date(r.created_at.replace(' ', 'T') + 'Z').getTime();
      return Number.isFinite(created) && created >= cutoff;
    });
    if (fresh.length === 0) return 0;

    const updates = matcher.match(observed, fresh);
    let backfilled = 0;
    for (const u of updates) {
      try {
        const ok = this.cfg.store.recordOutcome({
          id: u.id,
          true_outcome: u.true_outcome,
          outcome_confidence: u.outcome_confidence,
        });
        if (ok) {
          backfilled++;
          this.totalBackfilled++;
        }
      } catch {
        // Never throw from a feedback collector.
      }
    }
    return backfilled;
  }

  stats(): { totalBackfilled: number; matchersCount: number; pipelines: string[] } {
    return {
      totalBackfilled: this.totalBackfilled,
      matchersCount: this.matchersByPipeline.size,
      pipelines: Array.from(this.matchersByPipeline.keys()),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Concrete matchers — pre-built for the three pipelines that currently
// emit shadow predictions. New pipelines register their own matcher.
// ─────────────────────────────────────────────────────────────────────────

/**
 * ToolSelectionOutcomeMatcher — observed event = "the agent invoked tool X
 * in the next N turns after the selection was made". Matches by session +
 * recent query_hash.
 */
export interface ToolSelectionObservedEvent {
  /** Same query hash that was used when the shadow row was written. */
  queryHash: string;
  /** Tool names the agent ACTUALLY called after the selection. */
  toolsCalled: string[];
  /**
   * Optional compact Agent Decision Engine metadata. Kept as unknown here to
   * avoid coupling the generic shadow-traffic service to code-agent types;
   * callers pass the JSON-safe AgentDecisionTelemetry shape.
   */
  agentDecision?: unknown;
}

export class ToolSelectionOutcomeMatcher implements OutcomeMatcher<ToolSelectionObservedEvent> {
  readonly pipelineName = 'tool_selection';
  readonly maxAgeMs: number;
  constructor(maxAgeMs = 30 * 60 * 1000) { this.maxAgeMs = maxAgeMs; }
  match(observed: ToolSelectionObservedEvent, pending: CounterfactualLogRow[]) {
    const matched: Array<{ id: number; true_outcome: unknown }> = [];
    for (const row of pending) {
      if (row.query_hash !== observed.queryHash) continue;
      matched.push({
        id: row.id,
        true_outcome: observed.agentDecision === undefined
          ? { toolsCalled: observed.toolsCalled }
          : { toolsCalled: observed.toolsCalled, agentDecision: observed.agentDecision },
      });
    }
    return matched;
  }
}

/**
 * RolePipelineOutcomeMatcher — observed event = "master spawned this role
 * for this task". Matches the most recent pending row in the same session.
 */
export interface RolePipelineObservedEvent {
  queryHash: string;
  roleSpawned: string;
  agentRunId?: number;
}

export class RolePipelineOutcomeMatcher implements OutcomeMatcher<RolePipelineObservedEvent> {
  readonly pipelineName = 'role_pipeline';
  readonly maxAgeMs: number;
  constructor(maxAgeMs = 10 * 60 * 1000) { this.maxAgeMs = maxAgeMs; }
  match(observed: RolePipelineObservedEvent, pending: CounterfactualLogRow[]) {
    const matches = pending.filter((r) => r.query_hash === observed.queryHash);
    return matches.map((r) => ({
      id: r.id,
      true_outcome: { roleSpawned: observed.roleSpawned, agentRunId: observed.agentRunId },
      outcome_confidence: 1,
    }));
  }
}

/**
 * KanbanPriorityOutcomeMatcher — observed event = "card N moved to done".
 * The "true ordering" is the sequence of cards that completed. We treat
 * each transition as a partial outcome on any matching pending row.
 */
export interface KanbanPriorityObservedEvent {
  queryHash: string;
  cardIdMovedToDone: number;
  rankAmongCompleted: number;
}

export class KanbanPriorityOutcomeMatcher implements OutcomeMatcher<KanbanPriorityObservedEvent> {
  readonly pipelineName = 'kanban_priority';
  readonly maxAgeMs: number;
  constructor(maxAgeMs = 24 * 60 * 60 * 1000) { this.maxAgeMs = maxAgeMs; }
  match(observed: KanbanPriorityObservedEvent, pending: CounterfactualLogRow[]) {
    return pending
      .filter((r) => r.query_hash === observed.queryHash)
      .map((r) => ({
        id: r.id,
        true_outcome: {
          cardIdMovedToDone: observed.cardIdMovedToDone,
          rankAmongCompleted: observed.rankAmongCompleted,
        },
      }));
  }
}
