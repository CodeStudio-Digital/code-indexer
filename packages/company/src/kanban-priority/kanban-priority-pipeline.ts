/**
 * KanbanPriorityPipeline factory + convenience helper.
 */
import { CandidatePipeline, type TelemetrySink } from '@mcp/candidate-pipeline';
import {
  ActiveColumnFilter,
  BlockedByScorer,
  BlocksOthersScorer,
  EffortScorer,
  ImpactScorer,
  KanbanCardsSource,
  PrioritySortSelector,
  RoleAvailabilityScorer,
  UrgencyScorer,
  WeightedFusionScorer,
} from './stages.js';
import type {
  KanbanCandidate,
  KanbanCardInput,
  KanbanPriorityQuery,
} from './types.js';

export interface KanbanPriorityPipelineOptions {
  telemetry?: TelemetrySink;
}

export function createKanbanPriorityPipeline(
  options: KanbanPriorityPipelineOptions = {},
): CandidatePipeline<KanbanPriorityQuery, KanbanCandidate> {
  return new CandidatePipeline<KanbanPriorityQuery, KanbanCandidate>(
    { name: 'kanban_priority', telemetry: options.telemetry },
    {
      sources: [new KanbanCardsSource()],
      filters: [new ActiveColumnFilter()],
      scorers: [
        new ImpactScorer(),
        new EffortScorer(),
        new BlocksOthersScorer(),
        new BlockedByScorer(),
        new UrgencyScorer(),
        new RoleAvailabilityScorer(),
        new WeightedFusionScorer(),
      ],
      selector: new PrioritySortSelector(),
    },
  );
}

export interface PrioritizedKanban {
  /** Cards ordered by priority (highest first). `done` cards are dropped. */
  ordered: KanbanCardInput[];
  /** Per-card diagnostics — useful for UI tooltips. */
  diagnostics: Array<{
    id: number;
    score: number;
    signals: KanbanCandidate['signals'];
  }>;
  durationMs: number;
}

export async function prioritizeKanban(
  pipeline: CandidatePipeline<KanbanPriorityQuery, KanbanCandidate>,
  query: KanbanPriorityQuery,
): Promise<PrioritizedKanban> {
  const result = await pipeline.execute(query);
  return {
    ordered: result.selected.map((c) => c.card),
    diagnostics: result.selected.map((c) => ({
      id: c.card.id,
      score: c.score,
      signals: c.signals,
    })),
    durationMs: result.diag.durationMs,
  };
}
