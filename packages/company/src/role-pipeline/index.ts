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
