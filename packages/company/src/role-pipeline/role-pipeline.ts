/**
 * RolePipeline factory + convenience helper.
 */
import { CandidatePipeline, type TelemetrySink } from '@mcp/candidate-pipeline';
import {
  ActiveIdleRunsSource,
  BlockedRolesFilter,
  CapacityFilter,
  CostScorer,
  DiverseTopKSelector,
  HistorySuccessScorer,
  ReuseBonusScorer,
  RoleEmbeddingHydrator,
  TaskEmbeddingHydrator,
  TemplateRosterSource,
  TwoTowerScorer,
  WeightedFusionScorer,
  type EmbeddingFn,
  type HistorySuccessSource,
  type RoleEmbeddingStore,
} from './stages.js';
import { DEFAULT_TOP_K, type RoleCandidate, type RolePipelineQuery } from './types.js';

export interface RolePipelineOptions {
  embed: EmbeddingFn;
  roleEmbeddingStore: RoleEmbeddingStore;
  /** Optional: pulls success rates from telemetry. */
  historySource?: HistorySuccessSource | null;
  telemetry?: TelemetrySink;
  k?: number;
}

export function createRolePipeline(
  options: RolePipelineOptions,
): CandidatePipeline<RolePipelineQuery, RoleCandidate> {
  return new CandidatePipeline<RolePipelineQuery, RoleCandidate>(
    { name: 'role_pipeline', telemetry: options.telemetry },
    {
      queryHydrators: [new TaskEmbeddingHydrator(options.embed)],
      sources: [new TemplateRosterSource(), new ActiveIdleRunsSource()],
      hydrators: [new RoleEmbeddingHydrator(options.embed, options.roleEmbeddingStore)],
      filters: [new BlockedRolesFilter(), new CapacityFilter()],
      scorers: [
        new TwoTowerScorer(),
        new HistorySuccessScorer(options.historySource ?? null),
        new CostScorer(),
        new ReuseBonusScorer(),
        new WeightedFusionScorer(),
      ],
      selector: new DiverseTopKSelector(options.k ?? DEFAULT_TOP_K),
    },
  );
}

export interface RoleRecommendation {
  role: string;
  kind: 'spawn' | 'reuse';
  agentRunId?: number;
  score: number;
  signals: RoleCandidate['signals'];
}

export interface PrioritizedRolesResult {
  recommendations: RoleRecommendation[];
  durationMs: number;
}

export async function recommendRoles(
  pipeline: CandidatePipeline<RolePipelineQuery, RoleCandidate>,
  query: RolePipelineQuery,
): Promise<PrioritizedRolesResult> {
  const result = await pipeline.execute(query);
  return {
    recommendations: result.selected.map((c) => ({
      role: c.role.role,
      kind: c.kind,
      agentRunId: c.idleRun?.agentRunId,
      score: c.score,
      signals: c.signals,
    })),
    durationMs: result.diag.durationMs,
  };
}
