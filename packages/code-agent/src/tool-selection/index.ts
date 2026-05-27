/**
 * Public surface of the tool-selection module.
 *
 * Consumers (the runner / tool-list builder) need only `createToolSelectionPipeline`
 * and `selectTools`; the stages and helpers are exported for advanced use cases
 * (custom scorers, A/B variants, tests).
 */
export {
  createToolSelectionPipeline,
  selectTools,
  type ToolSelectionPipelineOptions,
  type SelectToolsResult,
} from './tool-selection-pipeline.js';

export type {
  ToolCandidate,
  ToolSelectionQuery,
} from './types.js';
export { DEFAULT_TOP_K } from './types.js';

export {
  TaskEmbeddingHydrator,
  ToolRegistrySource,
  ToolEmbeddingHydrator,
  TierFilter,
  TwoTowerScorer,
  FrequencyBoostScorer,
  RecencyScorer,
  WeightedFusionScorer,
  EssentialAwareTopKSelector,
  type EmbeddingFn,
  type ToolEmbeddingStore,
} from './stages.js';

export { InMemoryToolEmbeddingStore } from './tool-embedding-store.js';

export { ESSENTIAL_TOOL_NAMES, categorizeTool, toCandidate } from './helpers.js';

export {
  buildToolSelectionShadowVariants,
  DEFAULT_TOOL_SELECTION_VARIANTS,
  type ToolSelectionShadowConfig,
} from './shadow-variants.js';

export {
  applyToolSelection,
  type ApplyToolSelectionOptions,
} from './runtime-helper.js';

export {
  applyToolSelectionThin,
  clearTaskEmbeddingCacheForTests,
  type ApplyToolSelectionThinOptions,
  type ThinTool,
} from './runtime-helper-thin.js';

export {
  setGlobalToolSelectionFilter,
  getGlobalToolSelectionFilter,
  setGlobalToolSelectionOutcomeObserver,
  getGlobalToolSelectionOutcomeObserver,
  type ToolSelectionOutcomeObserver,
} from './global-filter.js';

// A2 — Sprint 3 safety filter
export {
  applyToolSelectionSafety,
  type SafetyContext,
  type SafetyFilterResult,
} from './safety-filter.js';
