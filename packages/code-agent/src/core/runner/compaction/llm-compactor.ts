/**
 * LLM-based history compactor. Splits the message history into
 *   head (compactable) = messages[0..cutoff)
 *   tail (verbatim)    = messages[cutoff..]
 * where `cutoff` is computed by walking from the tail until the running
 * token estimate exceeds `protectTokens` (~15% of effective window).
 *
 * Steps:
 *   1. `computeCutoffIndexByTokens` — token-based cutoff scan.
 *   2. `snapCutoffPreservingPairs` — never split a tool_use / tool_result
 *      pair; recede the cutoff when necessary.
 *   3. `recedeToPreserveLastNTurns` — Kimi-style "preserve last 2 user turns"
 *      so the tail always retains recent user intent verbatim.
 *   4. `summarizeSpanV3` — produce a chapter + continuation snapshot in one call.
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
  recedeToPreserveLastNRenderableTurns,
} from '@mcp/code-agent/core/compaction/cutoff.js';
import {
  COMPACTION_SUMMARY_TIMEOUT_MS,
  isCompactionSummaryV3,
  summarizeSpanV3,
  summaryV2ToV3,
  type CompactionLiveStateV3,
  type CompactionResumeV3,
  type CompactionSummaryV2,
  type CompactionSummaryV3,
  type SummarizeSpanV3Input,
  type SummarizeSpanV3Options,
} from '@mcp/code-agent/core/summarizer.js';
import { preserveLastNTurns } from '../recovery-config.js';
import { computeMinTailTurns } from './threshold.js';
import { renderSummaryAsMessage } from './summary-renderer.js';

export interface CompactArgs {
  messages: AgentMessage[];
  /** Tokens to keep verbatim at the tail (~15% of effective window). */
  protectTokens: number;
  /**
   * Optional ceiling on the preserved tail when receding to keep the last N
   * user turns. Stops a single long user turn (history has < N user messages)
   * from preserving everything and forcing a no-op. See
   * `recedeToPreserveLastNTurns`. Unset → unbounded recede (legacy behaviour).
   */
  maxTailTokens?: number;
  /** Cheap provider used for the summary call. */
  summaryProvider: ChatProvider;
  /** Session provider used once when the auxiliary binding fails. */
  fallbackProvider?: ChatProvider;
  /** Resolved pipeline binding config applied to every summary request. */
  summaryOptions?: Omit<SummarizeSpanV3Options, 'signal'>;
  /**
   * Legacy test/caller injection. Kept source-compatible during the V3
   * rollout; V2 results are converted losslessly enough for resume use.
   */
  summarize?: (
    head: AgentMessage[],
    provider: ChatProvider,
  ) => Promise<CompactionSummaryV2 | CompactionSummaryV3 | null>;
  /** V3-native injection point with separated prior/span/live state. */
  summarizeV3?: (
    input: SummarizeSpanV3Input,
    provider: ChatProvider,
    options?: SummarizeSpanV3Options,
  ) => Promise<CompactionSummaryV3 | null>;
  previousResume?: CompactionResumeV3 | string | null;
  liveState?: CompactionLiveStateV3 | null;
  /** Hard ceiling for both real and injected summarizers. Defaults to 45s. */
  summaryTimeoutMs?: number;
  /**
   * Optional abort signal. When fired BEFORE / DURING the LLM summary
   * call, the await races against the signal and rejects with an abort
   * error rather than hanging on a stalled aux provider.
   */
  signal?: AbortSignal;
}

export interface CompactResult {
  ok: boolean;
  /** New history (may be identical to input on no-op). */
  messages: AgentMessage[];
  /** The structured summary produced (null on no-op or failure). */
  summary: CompactionSummaryV3 | null;
  /** Number of messages collapsed from the head. */
  collapsedFrom: number;
  /** Number of messages produced in their place (currently always 1). */
  collapsedTo: number;
  /** Resolved cutoff index after all snap/recede passes. */
  cutoffApplied: number;
  /** Carries the underlying error when `ok === false`. */
  error?: Error;
  /** Provider that produced the accepted V3 object. */
  summaryProviderName?: string;
  summaryModel?: string;
  /** Sanitized failures from providers tried before the final outcome. */
  attemptErrors?: string[];
}

/**
 * Shared cutoff resolution — token scan, Kimi-style user-turn recede,
 * renderable-turn floor, then pair-preserving snap. Used by both the LLM
 * path and the mechanical fallback so they always agree on head/tail.
 */
function resolveCutoff(
  messages: AgentMessage[],
  protectTokens: number,
  maxTailTokens?: number,
): number {
  let cutoff = computeCutoffIndexByTokens(messages, protectTokens);
  cutoff = recedeToPreserveLastNTurns(messages, cutoff, preserveLastNTurns(), maxTailTokens);
  // Message-count floor: keep at least the last N renderable turns verbatim so a
  // token-dense tail can't collapse the recent working state. Bounded by the
  // same recede ceiling (`maxTailTokens`) so it never overflows the window.
  const renderableTurns = messages.reduce((acc, m) => acc + (m.role !== 'tool' ? 1 : 0), 0);
  cutoff = recedeToPreserveLastNRenderableTurns(
    messages, cutoff, computeMinTailTurns(renderableTurns), maxTailTokens,
  );
  return snapCutoffPreservingPairs(messages, cutoff);
}

export async function compactWithLLM(args: CompactArgs): Promise<CompactResult> {
  if (args.messages.length === 0) {
    return noOp(args.messages);
  }

  const cutoff = resolveCutoff(args.messages, args.protectTokens, args.maxTailTokens);

  // No-op when nothing is compactable.
  if (cutoff <= 0 || cutoff >= args.messages.length) {
    return noOp(args.messages, cutoff);
  }

  const head = args.messages.slice(0, cutoff);
  const tail = args.messages.slice(cutoff);

  try {
    // Race the summary call against the abort signal (A3). If the aux
    // provider stalls and the user aborts, we throw immediately instead
    // of holding the Compacting node hostage.
    const input: SummarizeSpanV3Input = {
      previousResume: args.previousResume,
      messages: head,
      liveState: args.liveState,
    };
    const timeoutMs = args.summaryTimeoutMs ?? args.summaryOptions?.timeoutMs ?? COMPACTION_SUMMARY_TIMEOUT_MS;
    const providers = [args.summaryProvider];
    const fallback = args.fallbackProvider;
    if (fallback && (fallback !== args.summaryProvider
      || fallback.name !== args.summaryProvider.name
      || fallback.model !== args.summaryProvider.model)) {
      providers.push(fallback);
    }
    const attemptErrors: string[] = [];
    let lastAttemptError: Error | null = null;
    let produced: CompactionSummaryV2 | CompactionSummaryV3 | null = null;
    let usedProvider: ChatProvider | null = null;
    for (const candidate of providers) {
      try {
        const options = { ...args.summaryOptions, signal: args.signal, timeoutMs };
        const pending = args.summarizeV3
          ? args.summarizeV3(input, candidate, options)
          : args.summarize
            ? args.summarize(head, candidate)
            : summarizeSpanV3(input, candidate, options);
        produced = await raceSummary(pending, args.signal, timeoutMs);
        if (produced) {
          usedProvider = candidate;
          break;
        }
        attemptErrors.push(`${candidate.name}/${candidate.model}: summarizer returned no valid V3 JSON`);
      } catch (error) {
        if (args.signal?.aborted) throw error;
        lastAttemptError = error instanceof Error ? error : new Error(String(error));
        attemptErrors.push(`${candidate.name}/${candidate.model}: ${lastAttemptError.message}`);
      }
    }
    if (!produced || !usedProvider) {
      return {
        ok: false,
        messages: args.messages,
        summary: null,
        collapsedFrom: 0,
        collapsedTo: 0,
        cutoffApplied: cutoff,
        error: providers.length === 1 && lastAttemptError
          ? lastAttemptError
          : new Error(attemptErrors.join(' | ') || 'summarizeSpanV3 returned null'),
        attemptErrors,
      };
    }
    const summary = isCompactionSummaryV3(produced) ? produced : summaryV2ToV3(produced);
    const synthetic = renderSummaryAsMessage(summary);
    return {
      ok: true,
      messages: [synthetic, ...tail],
      summary,
      collapsedFrom: head.length,
      collapsedTo: 1,
      cutoffApplied: cutoff,
      summaryProviderName: usedProvider.name,
      summaryModel: usedProvider.model,
      attemptErrors,
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
      attemptErrors: [e instanceof Error ? e.message : String(e)],
    };
  }
}

/**
 * Deterministic last-resort compaction — same cutoff pipeline as
 * `compactWithLLM` but NO summary: the head is simply dropped and replaced
 * with a one-line marker. Used by the Compacting node when the summarizer
 * failed twice in the same visit: losing the summary is strictly better than
 * losing the run. Never mutates the input array.
 */
export function truncateHeadMechanically(args: {
  messages: AgentMessage[];
  protectTokens: number;
  maxTailTokens?: number;
}): CompactResult {
  if (args.messages.length === 0) return noOp(args.messages);

  const cutoff = resolveCutoff(args.messages, args.protectTokens, args.maxTailTokens);
  if (cutoff <= 0 || cutoff >= args.messages.length) {
    return noOp(args.messages, cutoff);
  }

  const head = args.messages.slice(0, cutoff);
  const tail = args.messages.slice(cutoff);
  const synthetic: AgentMessage = {
    role: 'user',
    content: [{
      type: 'text',
      text:
        `<system-reminder>[context truncated] The runner dropped ${head.length} earlier messages ` +
        'after repeated summarizer failures (no summary available). Recent messages are intact. ' +
        'Re-read files you still need; earlier tool outputs may be recoverable via ' +
        '`get_tool_output`.</system-reminder>',
    }],
  };
  return {
    ok: true,
    messages: [synthetic, ...tail],
    summary: null,
    collapsedFrom: head.length,
    collapsedTo: 1,
    cutoffApplied: cutoff,
  };
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

/**
 * Race the summarize promise against `signal`. The listener is removed in
 * `finally` so this never leaks even on the happy path. Same shape as
 * `withAbort` in `nodes/executing-abort.ts` — kept local here to avoid a
 * cross-folder import.
 */
async function raceSummary<T>(
  p: Promise<T>,
  signal?: AbortSignal,
  timeoutMs = COMPACTION_SUMMARY_TIMEOUT_MS,
): Promise<T> {
  if (signal?.aborted) {
    const error = new Error('compactWithLLM aborted by signal');
    error.name = 'AbortError';
    throw error;
  }
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = (): void => {
        const error = new Error('compactWithLLM aborted by signal');
        error.name = 'AbortError';
        reject(error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error(`compactWithLLM summarizer timed out after ${timeoutMs}ms`);
          error.name = 'TimeoutError';
          reject(error);
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }
      p.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
