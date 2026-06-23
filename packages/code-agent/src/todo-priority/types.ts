/**
 * Types for the TodoPriorityPipeline.
 *
 * Goal: reorder a TodoWrite list by computed priority (impact × urgency ×
 * dependencies × effort) instead of relying on the agent's FIFO ordering.
 * Items that block other items move to the top; items that are themselves
 * blocked move down. Quick wins (short descriptions) get a small bump.
 *
 * Inspired by the weighted-sum scorer with positive AND negative weights
 * from `home-mixer/weighted_scorer.rs:44-70`.
 */
import type { PipelineCandidate, PipelineQuery } from '@mcp/candidate-pipeline';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Stable id across reorderings. */
  id: string;
  status: TodoStatus;
  /** Imperative form ("Run tests"). */
  content: string;
  /** Present-continuous form ("Running tests"). */
  activeForm: string;
  /** Stable insertion timestamp — drives urgency for stalled in_progress. */
  createdAtMs?: number;
  /**
   * Ids of OTHER todos this one explicitly references (e.g. "depends on #3").
   * Caller supplies; the pipeline doesn't try to re-parse content for refs.
   */
  refs?: string[];
}

export interface TodoPriorityQuery extends PipelineQuery {
  /** Full todo list, oldest → newest as the caller currently has them. */
  items: TodoItem[];
  /** Current time in ms (for urgency). Defaults to Date.now(). */
  nowMs?: number;
  /** Optional weight override. */
  weights?: TodoPriorityWeights;
}

export interface TodoPriorityWeights {
  impact: number;
  blocksOthers: number;
  urgency: number;
  effort: number;
  dependencyMet: number;
  blocked: number;
}

export const DEFAULT_WEIGHTS: TodoPriorityWeights = {
  impact:        +1.0,
  blocksOthers:  +0.7,
  urgency:       +0.5,
  effort:        +0.3,
  dependencyMet: +0.4,
  blocked:       -0.6, // negative — blocked items move DOWN
};

export interface TodoCandidate extends PipelineCandidate {
  item: TodoItem;
  /** Per-signal contribution (debug). */
  signals: {
    impact?: number;
    blocksOthers?: number;
    urgency?: number;
    effort?: number;
    dependencyMet?: number;
    blocked?: number;
  };
  /** Final weighted score. */
  score: number;
  /**
   * Computed adjacency — set by DependencyGraphHydrator. Lists the
   * `pending` ids that depend on this item.
   */
  blockedByThis: string[];
  /** Lists ids THIS item depends on (only `pending` ones tracked). */
  blockedBy: string[];
}
