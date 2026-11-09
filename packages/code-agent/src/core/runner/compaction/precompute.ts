/**
 * Background compaction-summary precompute (perf W1).
 *
 * Telemetry showed the turn where the summarizer runs inline costs ~156s vs
 * ~40s for a normal turn: the whole run stalls while `summarizeSpanV3` chews
 * through the head. This module starts that summary EARLY — when the post-turn
 * size gate is within `PRECOMPUTE_LEAD_RATIO` of the trigger — so by the time
 * `TokenThresholdHit` actually fires, the Compacting node can consume a
 * ready-made result instead of blocking on the LLM.
 *
 * Correctness model:
 *   - The precompute runs `compactWithLLM` over a SHALLOW SNAPSHOT of
 *     `ctx.messages`. Between durable compactions the history only APPENDS,
 *     so the snapshot's head `[0..cutoffApplied)` stays valid; consuming it
 *     just preserves a slightly longer verbatim tail (the messages that
 *     arrived after the kick) — a strictly safe outcome.
 *   - Consumption verifies the head by REFERENCE IDENTITY against the live
 *     array (message objects are treated immutably across the runner: every
 *     rewrite path replaces objects rather than mutating them). Any mismatch
 *     (spill, mechanical truncation, durable reducer flush) falls back to the
 *     inline path — never a wrong summary, at worst the old latency.
 *   - `compactWithLLM` never rejects (errors surface as `ok:false`), so the
 *     fire-and-forget promise cannot become an unhandled rejection.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { RunContext } from '../machine/types.js';
import { compactWithLLM, type CompactResult } from './llm-compactor.js';
import { computeProtectTokens, resolveRecedeTailRatio, resolveTriggerRatio } from './threshold.js';

/** How far below the trigger ratio the background summary is kicked. */
export const PRECOMPUTE_LEAD_RATIO = 0.08;

export interface SummaryPrecomputeState {
  /** Shallow snapshot of `ctx.messages` at kick time (reference copies). */
  snapshot: AgentMessage[];
  startedAt: number;
  /** Full `compactWithLLM` result over the snapshot. Never rejects. */
  promise: Promise<CompactResult>;
}

/** True when `ratio` is close enough to the trigger to warrant a precompute. */
export function shouldKickPrecompute(ratio: number): boolean {
  return ratio >= resolveTriggerRatio() - PRECOMPUTE_LEAD_RATIO;
}

/**
 * Start (or keep) the background summary for the current history. Idempotent:
 * an existing precompute whose snapshot still prefixes the live array is kept
 * — appends don't invalidate it, and a fresh kick would only waste a second
 * summary call over a marginally longer head.
 */
export function maybeKickSummaryPrecompute(ctx: RunContext): void {
  const existing = ctx.summaryPrecompute;
  if (existing) {
    if (snapshotStillPrefixes(existing.snapshot, ctx.messages)) return;
    // Head rewritten since the kick (spill / mechanical truncation). The old
    // promise settles harmlessly in the background; start over.
    ctx.summaryPrecompute = null;
  }
  if (ctx.messages.length === 0) return;

  const contextProvider = ctx.opts.provider;
  const summaryProvider = ctx.opts.compactionProvider ?? contextProvider;
  const protectTokens = computeProtectTokens({
    model: contextProvider.model,
    contextWindow: ctx.opts.contextWindow,
  });
  const maxTailTokens = computeProtectTokens({
    model: contextProvider.model,
    contextWindow: ctx.opts.contextWindow,
    protectRatio: resolveRecedeTailRatio(),
  });

  const snapshot = ctx.messages.slice();
  ctx.summaryPrecompute = {
    snapshot,
    startedAt: Date.now(),
    promise: compactWithLLM({
      messages: snapshot,
      protectTokens,
      maxTailTokens,
      summaryProvider,
      fallbackProvider: contextProvider,
      summaryOptions: ctx.opts.compactionSummaryOptions,
      liveState: readLiveState(ctx),
      signal: ctx.opts.toolContext.signal,
    }),
  };
  console.log(
    `[coder] compaction summary precompute started (messages=${snapshot.length})`,
  );
}

/**
 * Consume a precomputed summary for the live history, or null when the inline
 * path must run (no precompute, summary failed, or the head diverged). Always
 * clears the slot — a result is single-use either way.
 */
export async function takePrecomputedCompaction(
  ctx: RunContext,
): Promise<CompactResult | null> {
  const pre = ctx.summaryPrecompute;
  if (!pre) return null;
  ctx.summaryPrecompute = null;

  const result = await pre.promise;
  if (!result.ok || !result.summary || result.collapsedFrom <= 0) return null;
  const cutoff = result.cutoffApplied;
  if (cutoff <= 0 || cutoff >= ctx.messages.length) return null;
  if (!headIsIdentical(pre.snapshot, ctx.messages, cutoff)) return null;

  // Rebase onto the LIVE tail: everything at/after the snapshot cutoff —
  // including messages appended since the kick — stays verbatim.
  const synthetic = result.messages[0];
  if (!synthetic) return null;
  return {
    ...result,
    messages: [synthetic, ...ctx.messages.slice(cutoff)],
    collapsedFrom: cutoff,
    collapsedTo: 1,
  };
}

function snapshotStillPrefixes(snapshot: AgentMessage[], live: AgentMessage[]): boolean {
  if (snapshot.length > live.length) return false;
  // Sampling head/tail of the snapshot is not enough: a mid-array rewrite
  // (durable reducer) must invalidate. Full identity scan is O(n) pointer
  // compares — negligible next to a summary call.
  return headIsIdentical(snapshot, live, snapshot.length);
}

function headIsIdentical(snapshot: AgentMessage[], live: AgentMessage[], upTo: number): boolean {
  if (upTo > snapshot.length || upTo > live.length) return false;
  for (let i = 0; i < upTo; i++) {
    if (snapshot[i] !== live[i]) return false;
  }
  return true;
}

function readLiveState(ctx: RunContext): Parameters<typeof compactWithLLM>[0]['liveState'] {
  try {
    const state = ctx.bridge?.getSessionStateData?.() ?? null;
    if (!state) return undefined;
    return {
      activePlan: state.activePlan,
      todos: state.todos.map((todo) => ({
        content: todo.label,
        activeForm: todo.label,
        status: todo.status,
      })),
    };
  } catch {
    return undefined;
  }
}
