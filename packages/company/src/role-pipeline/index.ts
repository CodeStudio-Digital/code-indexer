export {
  createRolePipeline,
  recommendRoles,
  type RolePipelineOptions,
  type RoleRecommendation,
  type PrioritizedRolesResult,
} from './role-pipeline.js';

export type {
  RoleCandidate,
  RoleDescriptor,
  IdleRunDescriptor,
  RolePipelineQuery,
} from './types.js';
export { DEFAULT_TOP_K, DEFAULT_WEIGHTS } from './types.js';

export {
  TaskEmbeddingHydrator,
  TemplateRosterSource,
  ActiveIdleRunsSource,
  RoleEmbeddingHydrator,
  CapacityFilter,
  BlockedRolesFilter,
  DisableRulesFilter,
  TwoTowerScorer,
  HistorySuccessScorer,
  CostScorer,
  ReuseBonusScorer,
  WeightedFusionScorer,
  DiverseTopKSelector,
  type EmbeddingFn,
  type HistorySuccessSource,
  type RoleEmbeddingStore,
} from './stages.js';

export { InMemoryRoleEmbeddingStore } from './role-embedding-store.js';

// C2 — disable-rules
export {
  emptyDisableContext,
  evaluateDisableRules,
  skipIfRolesSkipped,
  skipIfAnyRoleFailed,
  skipIfRoleAlreadyRunning,
  type SubordinateDisableContext,
  type SubordinateDisableRule,
  type DisableRuleEvaluation,
} from './disable-rules.js';

// C4 — post-selection context hydrator
export {
  RoleContextHydrator,
  type ContextFetcher,
  type RoleContextPayload,
  type RoleContextHydratorOptions,
} from './role-context-hydrator.js';
