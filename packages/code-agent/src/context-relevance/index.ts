export {
  createContextRelevancePipeline,
  compactSession,
  type ContextRelevancePipelineOptions,
  type CompactResult,
} from './context-relevance-pipeline.js';

export type {
  ContextRelevanceQuery,
  MessageCandidate,
  MessageRole,
  SessionMessage,
} from './types.js';

export {
  DEFAULT_PRESERVE_RECENT_TURNS,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  DEFAULT_WEIGHTS,
} from './types.js';

export {
  TaskEmbeddingHydrator,
  SessionMessagesSource,
  MessageEmbeddingHydrator,
  SystemMessageGuard,
  RecentTurnsGuard,
  AtomicBlockFilter,
  TaskAffinityScorer,
  RecencyScorer,
  InfoDensityScorer,
  DecisionMarkerScorer,
  WeightedFusionScorer,
  BudgetAwareSelector,
  type EmbeddingFn,
  type MessageEmbeddingStore,
} from './stages.js';

export { InMemoryMessageEmbeddingStore } from './message-embedding-store.js';

export { detectDecisionMarker, detectInfoDensity, estimateTokens, toCandidate } from './helpers.js';

export {
  applyContextCompaction,
  type ApplyCompactionOptions,
  type CompactionResult,
} from './runtime-helper.js';

export {
  setGlobalContextRelevancePipeline,
  isGlobalContextRelevanceEnabled,
  tryGlobalContextCompact,
} from './global-pipeline.js';
