/**
 * LLM-based history compactor. Splits the message history into
 *   head (compactable) = messages[0..cutoff)
 *   tail (verbatim)    = messages[cutoff..]
 * where `cutoff` is computed by walking from the tail until the running
 * token estimate exceeds `protectTokens` (~40% of effective window).
 *
 * Steps:
 *   1. `computeCutoffIndexByTokens` — token-based cutoff scan.
 *   2. `snapCutoffPreservingPairs` — never split a tool_use / tool_result
 *      pair; recede the cutoff when necessary.
 *   3. `recedeToPreserveLastNTurns` — Kimi-style "preserve last 2 user turns"
 *      so the tail always retains recent user intent verbatim.
 *   4. `summarizeSpanV2` — ask the aux provider for a structured summary.
 *   5. `renderSummaryAsMessage` — wrap as a single synthetic user message.
 *   6. Splice: result = [synthetic, ...tail].
 *
 * Failure modes:
 *   - cutoff === 0 (nothing to compact) → return no-op success.
 *   - cutoff === messages.length (everything is head, no tail to preserve)
 *     → return no-op success; caller should bail to recovery.
 *   - LLM call throws / returns null → return failure with the error so the
 *     caller can apply backoff / retry / circuit breaker.
 *
 * NEVER mutates the input `messages` array.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import {
  computeCutoffIndexByTokens,
  snapCutoffPreservingPairs,
  recedeToPreserveLastNTurns,
} from '@mcp/code-agent/core/compaction/cutoff.js';
import {
  summarizeSpanV2,
  type CompactionSummaryV2,
} from '@mcp/code-agent/core/summarizer.js';
import { preserveLastNTurns } from '../recovery-config.js';
import { renderSummaryAsMessage } from './summary-renderer.js';

export interface CompactArgs {
  messages: AgentMessage[];
  /** Tokens to keep verbatim at the tail (~40% of effective window). */
  protectTokens: number;
  /** Cheap provider used for the summary call. */
  summaryProvider: ChatProvider;
  /**
   * Optional injection point for tests — when set, replaces the call to
   * `summarizeSpanV2`. The default uses the real LLM path.
   */
  summarize?: (
    head: AgentMessage[],
    provider: ChatProvider,
  ) => Promise<CompactionSummaryV2 | null>;
}

export interface CompactResult {
  ok: boolean;
  /** New history (may be identical to input on no-op). */
  messages: AgentMessage[];
  /** The structured summary produced (null on no-op or failure). */
  summary: CompactionSummaryV2 | null;
  /** Number of messages collapsed from the head. */
  collapsedFrom: number;
  /** Number of messages produced in their place (currently always 1). */
  collapsedTo: number;
  /** Resolved cutoff index after all snap/recede passes. */
  cutoffApplied: number;
  /** Carries the underlying error when `ok === false`. */
  error?: Error;
}

export async function compactWithLLM(args: CompactArgs): Promise<CompactResult> {
  if (args.messages.length === 0) {
    return noOp(args.messages);
  }

  let cutoff = computeCutoffIndexByTokens(args.messages, args.protectTokens);
  cutoff = recedeToPreserveLastNTurns(args.messages, cutoff, preserveLastNTurns());
  cutoff = snapCutoffPreservingPairs(args.messages, cutoff);

  // No-op when nothing is compactable.
  if (cutoff <= 0 || cutoff >= args.messages.length) {
    return noOp(args.messages, cutoff);
  }

  const head = args.messages.slice(0, cutoff);
  const tail = args.messages.slice(cutoff);
  const summarize = args.summarize ?? summarizeSpanV2;

  try {
    const summary = await summarize(head, args.summaryProvider);
    if (!summary) {
      return {
        ok: false,
        messages: args.messages,
        summary: null,
        collapsedFrom: 0,
        collapsedTo: 0,
        cutoffApplied: cutoff,
        error: new Error('summarizeSpanV2 returned null'),
      };
    }
    const synthetic = renderSummaryAsMessage(summary);
    return {
      ok: true,
      messages: [synthetic, ...tail],
      summary,
      collapsedFrom: head.length,
      collapsedTo: 1,
      cutoffApplied: cutoff,
    };
  } catch (e) {
    return {
      ok: false,
      messages: args.messages,
      summary: null,
      collapsedFrom: 0,
      collapsedTo: 0,
      cutoffApplied: cutoff,
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

function noOp(messages: AgentMessage[], cutoff = 0): CompactResult {
  return {
    ok: true,
    messages,
    summary: null,
    collapsedFrom: 0,
    collapsedTo: 0,
    cutoffApplied: cutoff,
  };
}
