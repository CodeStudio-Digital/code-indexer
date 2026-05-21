/**
 * Runtime helper for the ContextRelevancePipeline. Wraps the typical
 * "decide which past messages to keep" flow with safe fallbacks.
 *
 * Pattern:
 *
 *   const { keptMessages, dropped } = await applyContextCompaction({
 *     messages: session.messages,
 *     taskText: latestUserMessage,
 *     tokenBudget: 100_000,
 *     pipeline,
 *   });
 *
 * Returns `messages` unchanged when:
 *   - pipeline is null
 *   - messages fit within the budget already (no compaction needed)
 *   - the pipeline throws (never break the harness)
 */
import type { CandidatePipeline } from '@mcp/candidate-pipeline';
import { compactSession, type CompactResult } from './context-relevance-pipeline.js';
import type {
  ContextRelevanceQuery,
  MessageCandidate,
  SessionMessage,
} from './types.js';

export interface ApplyCompactionOptions {
  messages: SessionMessage[];
  taskText: string;
  /** Available token budget. Compaction skipped when messages already fit. */
  tokenBudget: number;
  pipeline?: CandidatePipeline<ContextRelevanceQuery, MessageCandidate> | null;
  preserveRecentTurns?: number;
  /** Telemetry callback fired with the compaction diagnostics. */
  onResult?: (diag: CompactResult['diag']) => void;
  /** Optional override for the pipeline query id. */
  queryId?: string;
}

export interface CompactionResult {
  keptMessages: SessionMessage[];
  /** Messages the pipeline decided to drop. Empty when no compaction ran. */
  dropped: SessionMessage[];
  /** True iff the pipeline actually ran and produced a different set. */
  compacted: boolean;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function totalTokens(messages: SessionMessage[]): number {
  let n = 0;
  for (const m of messages) n += m.tokenCount ?? estimateTokens(m.text);
  return n;
}

export async function applyContextCompaction(options: ApplyCompactionOptions): Promise<CompactionResult> {
  const { messages, pipeline, taskText, tokenBudget } = options;
  if (!pipeline) return noop(messages);
  const currentTokens = totalTokens(messages);
  if (currentTokens <= tokenBudget) return noop(messages);

  try {
    const result = await compactSession(pipeline, {
      queryId: options.queryId ?? `compaction-${Date.now()}`,
      taskText,
      tokenBudget,
      preserveRecentTurns: options.preserveRecentTurns,
    });
    options.onResult?.(result.diag);
    return {
      keptMessages: result.keptMessages,
      dropped: result.droppedMessages,
      compacted: result.droppedMessages.length > 0,
    };
  } catch {
    return noop(messages);
  }
}

function noop(messages: SessionMessage[]): CompactionResult {
  return { keptMessages: messages, dropped: [], compacted: false };
}
