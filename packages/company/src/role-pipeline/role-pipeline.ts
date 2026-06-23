/**
 * RolePipeline factory + convenience helper.
 */
import { CandidatePipeline, type TelemetrySink } from '@mcp/candidate-pipeline';
import {
  ActiveIdleRunsSource,
  BlockedRolesFilter,
  CapacityFilter,
  CostScorer,
  DisableRulesFilter,
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
import { RoleContextHydrator, type ContextFetcher } from './role-context-hydrator.js';
import { DEFAULT_TOP_K, type RoleCandidate, type RolePipelineQuery } from './types.js';

export interface RolePipelineOptions {
  embed: EmbeddingFn;
  roleEmbeddingStore: RoleEmbeddingStore;
  /** Optional: pulls success rates from telemetry. */
  historySource?: HistorySuccessSource | null;
  telemetry?: TelemetrySink;
  k?: number;
  /**
   * Optional context fetcher for the C4 post-selection hydrator. When
   * provided, the top-K selected roles are enriched with relevant files
   * + kanban cards BEFORE the orchestrator spawns them. Absent → no
   * post-selection hydrator wired → bit-identical to pre-C4 behavior.
   */
  roleContextFetcher?: ContextFetcher;
  /** Per-candidate timeout for the C4 fetcher. Default 2000ms. */
  roleContextTimeoutMs?: number;
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
      // C2: DisableRulesFilter runs FIRST so dropped roles never pay
      // CapacityFilter / scoring cost. BlockedRolesFilter remains for
      // the legacy `blockedRoles: string[]` API (kanban hard-blocks).
      filters: [new DisableRulesFilter(), new BlockedRolesFilter(), new CapacityFilter()],
      scorers: [
        new TwoTowerScorer(),
        new HistorySuccessScorer(options.historySource ?? null),
        new CostScorer(),
        new ReuseBonusScorer(),
        new WeightedFusionScorer(),
      ],
      selector: new DiverseTopKSelector(options.k ?? DEFAULT_TOP_K),
      // C4 — post-selection hydration only runs when a fetcher is wired.
      // Absent → undefined → CandidatePipeline skips the stage entirely.
      postSelectionHydrators: options.roleContextFetcher
        ? [
            new RoleContextHydrator({
              fetcher: options.roleContextFetcher,
              timeoutMs: options.roleContextTimeoutMs,
            }),
          ]
        : undefined,
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
