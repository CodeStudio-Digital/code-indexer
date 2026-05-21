/**
 * TodoPriorityPipeline factory + `prioritizeTodos` convenience helper.
 */
import { CandidatePipeline, type TelemetrySink } from '@mcp/candidate-pipeline';
import {
  BlockedScorer,
  BlocksOthersScorer,
  DependencyGraphHydrator,
  DependencyMetScorer,
  EffortScorer,
  ImpactScorer,
  StatusAwareSelector,
  TodoListSource,
  UrgencyScorer,
  WeightedFusionScorer,
} from './stages.js';
import type { TodoCandidate, TodoItem, TodoPriorityQuery } from './types.js';

export interface TodoPriorityPipelineOptions {
  telemetry?: TelemetrySink;
}

export function createTodoPriorityPipeline(
  options: TodoPriorityPipelineOptions = {},
): CandidatePipeline<TodoPriorityQuery, TodoCandidate> {
  return new CandidatePipeline<TodoPriorityQuery, TodoCandidate>(
    { name: 'todo_priority', telemetry: options.telemetry },
    {
      sources: [new TodoListSource()],
      hydrators: [new DependencyGraphHydrator()],
      scorers: [
        new ImpactScorer(),
        new BlocksOthersScorer(),
        new UrgencyScorer(),
        new EffortScorer(),
        new DependencyMetScorer(),
        new BlockedScorer(),
        new WeightedFusionScorer(),
      ],
      selector: new StatusAwareSelector(),
    },
  );
}

export interface PrioritizedTodos {
  /** Reordered items: in_progress → pending (by priority) → completed. */
  ordered: TodoItem[];
  /** Per-item priority diagnostics (in same order as `ordered`). */
  diagnostics: Array<{
    id: string;
    score: number;
    signals: TodoCandidate['signals'];
    blockedByThis: string[];
    blockedBy: string[];
  }>;
  durationMs: number;
}

export async function prioritizeTodos(
  pipeline: CandidatePipeline<TodoPriorityQuery, TodoCandidate>,
  query: TodoPriorityQuery,
): Promise<PrioritizedTodos> {
  const result = await pipeline.execute(query);
  return {
    ordered: result.selected.map((c) => c.item),
    diagnostics: result.selected.map((c) => ({
      id: c.item.id,
      score: c.score,
      signals: c.signals,
      blockedByThis: c.blockedByThis,
      blockedBy: c.blockedBy,
    })),
    durationMs: result.diag.durationMs,
  };
}
