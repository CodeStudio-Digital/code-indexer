export type {
  ShadowQuery,
  ShadowVariant,
  ShadowVariantResult,
  ShadowEnvelope,
  ShadowTrafficStats,
} from './types.js';

export {
  ShadowTrafficRunner,
  type ShadowTrafficRunnerConfig,
} from './shadow-traffic-runner.js';

export {
  PipelineShadowVariant,
  type PipelineShadowVariantConfig,
} from './pipeline-shadow-variant.js';

export {
  FeedbackCollector,
  type FeedbackCollectorConfig,
  type OutcomeMatcher,
  ToolSelectionOutcomeMatcher,
  type ToolSelectionObservedEvent,
  RolePipelineOutcomeMatcher,
  type RolePipelineObservedEvent,
  KanbanPriorityOutcomeMatcher,
  type KanbanPriorityObservedEvent,
} from './feedback-collector.js';

export {
  setGlobalFeedbackCollector,
  getGlobalFeedbackCollector,
  observeOutcome,
} from './global-feedback.js';
