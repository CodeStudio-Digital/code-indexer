/**
 * Public surface of the compaction helpers under `./compaction/`.
 *
 * Destructive compaction is done by the LLM compactor in the Compacting
 * node; the per-turn view (`compactHistoryForLLM`) only applies the
 * deterministic rolling reduction. These re-exports keep the historical
 * import path (`from './compaction.js'`) working.
 */
export {
  AUTOCOMPACT_BUFFER_TOKENS,
  PROTECT_TOKEN_RATIO,
  COMPACT_CUMULATIVE_RATIO,
  COMPACT_POLLING_TRIGGER_RATIO,
  COMPACT_STUCK_TURN_CAP,
  computeCompactionTrigger,
  deriveTokenLimits,
} from './compaction/limits.js';
export type {
  TokenLimits,
  CompactionTriggerInputs,
  CompactionTriggerDecision,
} from './compaction/limits.js';

export {
  computeCutoffIndexByTokens,
  snapCutoffPreservingPairs,
  recedeToPreserveLastNTurns,
  recedeToPreserveLastNRenderableTurns,
} from './compaction/cutoff.js';

export {
  REDUCIBLE_READ_TOOLS,
  getStringField,
  buildReadDedupKey,
  applyRollingReduction,
} from './compaction/rolling-reduction.js';
export type { RollingReductionResult } from './compaction/rolling-reduction.js';

export {
  MUTATING_FS_TOOLS,
  isMutatingFsTool,
  isElidedReadContent,
  findToolResultByUseId,
  allPriorReadsElided,
  lastMutationTurn,
  extractReadPreview,
} from './compaction/elision.js';

export { buildSimpleLineDiff } from './compaction/diff.js';
