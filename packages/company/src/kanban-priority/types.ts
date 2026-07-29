/**
 * Types for the KanbanPriorityPipeline.
 *
 * Goal: order pending kanban cards by computed priority (impact × effort ×
 * dependencies × urgency × availability) so the company master can batch
 * approvals by predicted-value first.
 *
 * Mirrors the weighted-sum scoring pattern from `home-mixer/weighted_scorer.rs`
 * with positive AND negative weights (effort is negative so larger cards
 * score lower).
 */
import type { PipelineCandidate, PipelineQuery } from '@mcp/candidate-pipeline';

export type KanbanColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type KanbanTag = 'bug' | 'feature' | 'refactor' | 'documentation' | null;

export interface KanbanCardInput {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  tag: KanbanTag;
  /** Cards that this one blocks (their ids). */
  blocks?: string[];
  /** Cards that block this one (their ids). */
  blockedBy?: string[];
  /** Roles currently assigned to this card. */
  assignedRoles?: string[];
  createdAtMs?: number;
  /** When the card last moved to its current column (drives stalled urgency). */
  columnUpdatedAtMs?: number;
}

export interface KanbanPriorityQuery extends PipelineQuery {
  cards: KanbanCardInput[];
  /** Which roles are currently idle — boosts cards assigned to them. */
  idleRoles?: string[];
  nowMs?: number;
  weights?: KanbanPriorityWeights;
  k?: number;
}

export interface KanbanPriorityWeights {
  impact: number;
  effort: number;
  blocksOthers: number;
  urgency: number;
  roleAvailability: number;
  blockedBy: number;
}

export const DEFAULT_WEIGHTS: KanbanPriorityWeights = {
  impact:           +0.30,
  effort:           -0.20, // negative — larger cards score lower
  blocksOthers:     +0.25,
  urgency:          +0.15,
  roleAvailability: +0.10,
  blockedBy:        -0.30, // negative — blocked cards score lower
};

export interface KanbanCandidate extends PipelineCandidate {
  card: KanbanCardInput;
  signals: {
    impact?: number;
    effort?: number;
    blocksOthers?: number;
    urgency?: number;
    roleAvailability?: number;
    blockedBy?: number;
  };
  score: number;
}
