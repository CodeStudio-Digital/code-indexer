/**
 * Module-level holder for the ContextRelevance pipeline.
 *
 * The runtime queries `tryGlobalContextCompact(...)` when its compaction
 * trigger fires. When a pipeline is installed AND the env flag is on,
 * the pipeline gets first crack at deciding which messages to keep.
 * On any failure, the runner falls back to its deterministic compaction
 * path — the pipeline never breaks a turn.
 *
 * Mirror of `setGlobalToolSelectionFilter` /
 * `setGlobalQualityClassifierPipeline` patterns.
 */
import type { CandidatePipeline } from '@mcp/candidate-pipeline';
import {
  applyContextCompaction,
  type CompactionResult as PipelineCompactionResult,
} from './runtime-helper.js';
import type {
  ContextRelevanceQuery,
  MessageCandidate,
  SessionMessage,
} from './types.js';

let globalPipeline: CandidatePipeline<ContextRelevanceQuery, MessageCandidate> | undefined;
let enabled = false;

export function setGlobalContextRelevancePipeline(
  pipeline: CandidatePipeline<ContextRelevanceQuery, MessageCandidate> | undefined,
  isEnabled: boolean,
): void {
  globalPipeline = pipeline;
  enabled = isEnabled;
}

export function isGlobalContextRelevanceEnabled(): boolean {
  return enabled && globalPipeline != null;
}

/**
 * Ask the global pipeline to compact the message list. Returns the
 * pipeline's `CompactionResult` on success, or null when:
 *   - the pipeline isn't installed
 *   - the env flag is off
 *   - the pipeline threw (the helper already returns `compacted: false`,
 *     but we also defend against unexpected throws here)
 *
 * Callers should fall back to their existing compaction path when this
 * returns null OR `compacted: false`.
 */
export async function tryGlobalContextCompact(opts: {
  messages: SessionMessage[];
  taskText: string;
  tokenBudget: number;
  preserveRecentTurns?: number;
  onResult?: (diag: PipelineCompactionResult['dropped']) => void;
}): Promise<PipelineCompactionResult | null> {
  if (!enabled || !globalPipeline) return null;
  try {
    return await applyContextCompaction({
      messages: opts.messages,
      taskText: opts.taskText,
      tokenBudget: opts.tokenBudget,
      preserveRecentTurns: opts.preserveRecentTurns,
      pipeline: globalPipeline,
    });
  } catch {
    return null;
  }
}
