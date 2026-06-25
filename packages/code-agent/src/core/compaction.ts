/**
 * Auto-compaction for the coder agent's message history.
 *
 * Complements (does NOT replace) push-time tool_result truncation:
 *
 *   push-time truncation → every tool_result block is capped at creation,
 *                          preserving prefix cache within a session.
 *
 *   auto-compaction      → when the running total still overflows the
 *                          context window, replace the *content* of older
 *                          tool_result blocks with a deterministic marker.
 *
 * Determinism matters: compaction is applied per-turn by `compactHistoryForLLM`
 * and MUST produce the same output for the same prefix on every call, or we
 * bust server-side prompt caches. Public API lives in this file; bodies are
 * delegated to focused sub-modules under `./compaction/`.
 *
 * What we DO NOT do here:
 *   - Call an LLM to summarize the pruned region (lives in the summarizer).
 *   - Touch non-tool_result blocks. Assistant text and user messages are
 *     always preserved; only tool outputs are pruned.
 *   - Mutate the persistent history. Compaction is a per-turn transformation;
 *     the full transcript stays in the DB so the dashboard can display it.
 */
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { compactedMarker, totalChars } from './compaction/char-counts.js';
import {
  computeCutoffIndex,
  computeCutoffIndexByTokens,
  snapCutoffPreservingPairs,
  snapCutoffToRoleBoundary,
} from './compaction/cutoff.js';
import { PRUNE_MINIMUM, PRUNE_PROTECT } from './compaction/limits.js';

// Re-exports — preserve the historical public API of this file so external
// imports (`from './compaction.js'`) keep working without changes.
export {
  PRUNE_MINIMUM,
  PRUNE_PROTECT,
  AUTOCOMPACT_BUFFER_TOKENS,
  PROTECT_TOKEN_RATIO,
  COMPACT_CUMULATIVE_RATIO,
  COMPACT_POLLING_TRIGGER_RATIO,
  COMPACT_STUCK_TURN_CAP,
  computeCompactionTrigger,
  isNewCompactionEnabled,
  deriveCompactionLimits,
  deriveTokenLimits,
  shouldCompact,
} from './compaction/limits.js';
export type {
  CompactionLimits,
  TokenLimits,
  CompactionTriggerInputs,
  CompactionTriggerDecision,
} from './compaction/limits.js';

export { totalChars } from './compaction/char-counts.js';

export {
  computeCutoffIndex,
  computeCutoffIndexByTokens,
  snapCutoffPreservingPairs,
  recedeToPreserveLastNTurns,
  recedeToPreserveLastNRenderableTurns,
  snapCutoffToRoleBoundary,
} from './compaction/cutoff.js';

export {
  REDUCIBLE_READ_TOOLS,
  getStringField,
  buildReadDedupKey,
  applyRollingReduction,
} from './compaction/rolling-reduction.js';
export type { RollingReductionResult } from './compaction/rolling-reduction.js';

export { postCompactCleanup } from './compaction/post-cleanup.js';
export type { PostCompactResult } from './compaction/post-cleanup.js';

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
export { buildRichRefusal, buildAutoDowngradeResponse } from './compaction/refusal.js';
export type { RichRefusalArgs } from './compaction/refusal.js';

export interface CompactionResult {
  messages: AgentMessage[];
  /** Number of tool_result blocks whose content was replaced with a marker. */
  prunedBlocks: number;
  /** Sum of original content lengths across pruned blocks (approximate). */
  prunedChars: number;
  /** Whether compaction was actually applied (false = below threshold). */
  applied: boolean;
}

/**
 * Apply deterministic compaction. Pure function: does not mutate `messages`.
 * Returns a fresh array with replaced tool_result blocks past the cutoff.
 *
 * Supports two modes:
 *   - **char mode (legacy)**: pass `minimum`/`protect` (chars). Used when
 *     CODER_NEW_COMPACTION=0 or no model id is available.
 *   - **token mode (new)**: pass `protectTokens`. Cutoff computed by the
 *     hybrid token estimator; pairs are preserved atomically.
 */
export function compactMessages(
  messages: AgentMessage[],
  opts: {
    minimum?: number;
    protect?: number;
    /** When set, use token-based cutoff via `computeCutoffIndexByTokens`. */
    protectTokens?: number;
    /** When set, skip the char-total guard (token mode decides via shouldCompact). */
    skipMinimumGuard?: boolean;
  } = {},
): CompactionResult {
  const minimum = opts.minimum ?? PRUNE_MINIMUM;
  const protect = opts.protect ?? PRUNE_PROTECT;
  const useTokenCutoff = opts.protectTokens != null;

  if (!opts.skipMinimumGuard) {
    const total = totalChars(messages);
    if (total <= minimum) {
      return { messages, prunedBlocks: 0, prunedChars: 0, applied: false };
    }
  }

  let cutoff: number;
  if (useTokenCutoff) {
    cutoff = computeCutoffIndexByTokens(messages, opts.protectTokens!);
    cutoff = snapCutoffPreservingPairs(messages, cutoff);
  } else {
    cutoff = computeCutoffIndex(messages, protect);
    cutoff = snapCutoffToRoleBoundary(messages, cutoff);
  }
  if (cutoff === 0) {
    // Tail protection already covers the whole history; nothing to prune.
    return { messages, prunedBlocks: 0, prunedChars: 0, applied: false };
  }

  let prunedBlocks = 0;
  let prunedChars = 0;
  const out: AgentMessage[] = messages.map((m, idx): AgentMessage => {
    if (idx >= cutoff) return m;
    let touched = false;
    const newContent = m.content.map((b): ContentBlock => {
      if (b.type !== 'tool_result') return b;
      const originalContent = typeof b.content === 'string' ? b.content : '';
      if (!originalContent) return b;
      // Idempotent: skip blocks already carrying a compaction marker.
      if (originalContent.startsWith('[compacted:')) return b;
      prunedBlocks++;
      prunedChars += originalContent.length;
      touched = true;
      return {
        ...b,
        content: compactedMarker(originalContent.length),
        // Preserve truncated flag if it was already set; mark originalSize so
        // the DB layer (if it ever re-hydrates) can tell.
        truncated: true,
        originalSize: (b as { originalSize?: number }).originalSize ?? originalContent.length,
      };
    });
    return touched ? { ...m, content: newContent } : m;
  });

  return { messages: out, prunedBlocks, prunedChars, applied: prunedBlocks > 0 };
}
