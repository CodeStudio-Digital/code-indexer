/**
 * Pending-payload token estimate (PR-F, Kimi-style).
 *
 * Today the runner only learns the prompt-token count AFTER the provider
 * answers — so the request that finally tips the window over the cap
 * still goes out at full size. Kimi-cli's `_check_pending` runs BEFORE
 * the emit: it sums message tokens + the pending tool_result batch
 * tokens + the static prefix; if the projected total exceeds the cap,
 * compaction is triggered preemptively.
 *
 * This module provides:
 *   - `estimateMessagesTokens(messages)` — sum of all message content
 *     (including tool_result.content).
 *   - `estimatePendingPayload({...})` — full pre-emit projection
 *     including the not-yet-sent tool_result batch.
 *   - `shouldCompactPreEmit({...})` — gate that fires on the same
 *     0.90 ratio as `shouldCompact90` but using the projected total.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';
import { estimateBlockTokens, estimateMessageTokens } from '@mcp/code-agent/core/token-accounting.js';

/**
 * Sum estimated tokens for a full message array.
 *
 * Delegates to `estimateMessageTokens` (token-accounting) so non-text blocks
 * are costed correctly: an `image` is a fixed per-tile overhead (~1000 tokens),
 * NOT the length of its base64 payload. Counting base64 chars as text is what
 * caused a single attached image to project ~417K tokens and falsely trip the
 * pre-emit gate into `compact_exhausted`.
 */
export function estimateMessagesTokens(messages: ReadonlyArray<AgentMessage>): number {
  let tokens = 0;
  for (const m of messages) tokens += estimateMessageTokens(m);
  return tokens;
}

/** Estimate tokens for a batch of pending tool_result payloads (pre-emit). */
export function estimateToolResultsTokens(
  toolResults: ReadonlyArray<{ content: string | unknown }>,
): number {
  let tokens = 0;
  for (const r of toolResults) {
    const content = typeof r.content === 'string'
      ? r.content
      : (() => { try { return JSON.stringify(r.content ?? ''); } catch { return ''; } })();
    tokens += estimateBlockTokens({ type: 'tool_result', tool_use_id: '', content });
  }
  return tokens;
}

export interface EstimatePendingPayloadArgs {
  messages: ReadonlyArray<AgentMessage>;
  toolResults?: ReadonlyArray<{ content: string | unknown }>;
  /** Optional prefix-token estimate (system + tools). Default 0. */
  prefixTokens?: number;
}

/**
 * Sum of:
 *   - messagesTokens
 *   - toolResultsTokens
 *   - prefixTokens
 *
 * This is the size the LLM will see on the NEXT emit. Runner uses this
 * to short-circuit into Compacting BEFORE making the expensive call.
 */
export function estimatePendingPayload(args: EstimatePendingPayloadArgs): number {
  const m = estimateMessagesTokens(args.messages);
  const t = args.toolResults ? estimateToolResultsTokens(args.toolResults) : 0;
  const p = args.prefixTokens ?? 0;
  return m + t + p;
}

export interface ShouldCompactPreEmitInputs extends EstimatePendingPayloadArgs {
  model: string;
  /** Trigger ratio applied to TOTAL effective context. Default 0.90. */
  triggerRatio?: number;
}

export interface PreEmitCompactDecision {
  shouldCompact: boolean;
  projectedTokens: number;
  effective: number;
  ratio: number;
}

export const DEFAULT_PRE_EMIT_RATIO = 0.9;

/**
 * Pre-emit compaction gate. Returns `shouldCompact=true` when the
 * estimated next-request payload would meet or exceed `triggerRatio`
 * of the model's effective context window. Use to route into the
 * Compacting node BEFORE issuing the request.
 *
 * First-turn safeguard: if there are 0 or 1 messages, never pre-empt
 * — there's no body to compact and the estimate is too noisy.
 */
export function shouldCompactPreEmit(inp: ShouldCompactPreEmitInputs): PreEmitCompactDecision {
  if (inp.messages.length <= 1) {
    return { shouldCompact: false, projectedTokens: 0, effective: 0, ratio: 0 };
  }
  const limits = deriveTokenLimits(inp.model);
  const triggerRatio = inp.triggerRatio ?? DEFAULT_PRE_EMIT_RATIO;
  const projectedTokens = estimatePendingPayload(inp);
  if (limits.effective <= 0) {
    return { shouldCompact: false, projectedTokens, effective: limits.effective, ratio: 0 };
  }
  const ratio = projectedTokens / limits.effective;
  return {
    shouldCompact: ratio >= triggerRatio,
    projectedTokens,
    effective: limits.effective,
    ratio,
  };
}
