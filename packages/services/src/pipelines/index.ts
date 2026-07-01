/**
 * Pipelines — shared service-layer plumbing for the candidate-pipeline
 * framework. The framework itself (traits + orchestrator) lives in
 * `@mcp/candidate-pipeline`; this module provides the cross-cutting
 * services (provider resolution, feature flags, catalog) that every
 * concrete pipeline depends on.
 */
export {
  type Decider,
  type DeciderContext,
  ConfigJsonDecider,
  EnvVarDecider,
  ConstantDecider,
  CompositeDecider,
  defaultDecider,
} from './decider.js';

export {
  type ResolveContext,
  type ResolvedBinding,
  type FallbackDefault,
  PipelineProviderResolver,
  PipelineBindingMissingError,
} from './provider-resolver.js';

export {
  type BindingRole,
  type CapabilityKind,
  type PipelineCatalogEntry,
  PIPELINE_CATALOG,
  capabilityKindForRole,
  setupTargetsForCapability,
  groupCatalogByPipeline,
  findCatalogEntry,
} from './catalog.js';

export { generalDefaultAsFallback } from './general-fallback.js';

// A1 finalization — glue from Decider → CoderTunables.
export { tunablesFromDecider } from './coder-tunables-adapter.js';
