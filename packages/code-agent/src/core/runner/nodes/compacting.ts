/**
 * Compacting node — LLM-based context summarization. Entered after Executing
 * emits `TokenThresholdHit`. Delegates the heavy lifting to
 * `compactWithLLM`, then either yields `CompactionDone` so Reviewing can
 * sanity-check the new history, or bumps the `compact-failure` counter and
 * routes to Recovering via `ProviderError`.
 *
 * Strategy (per the BT plan §3):
 *   - cutoff via `computeCutoffIndexByTokens` with protect = 15% of effective
 *     context window, then snap to preserve tool pairs and recede to keep
 *     the last N user turns verbatim (Kimi-style), capped at `maxTailTokens`
 *     so a single long user turn can't defeat compaction.
 *   - summarize the head via the optional code-agent/compaction binding,
 *     falling back to the active session provider.
 *   - replace head with a single synthetic `user` message rendered from
 *     the bounded V3 resume (tagged blocks).
 *
 * On failure, the `compact-failure` circuit breaker (`recoveryCap=3` by
 * default) eventually aborts the run with `stopReason='compact_failure'`.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import { events } from '../machine/events.js';
import { bumpRecovery } from '../machine/context.js';
import { recoveryCap } from '../recovery-config.js';
import { compactWithLLM, truncateHeadMechanically } from '../compaction/llm-compactor.js';
import { computeProtectTokens, resolveRecedeTailRatio } from '../compaction/threshold.js';
import { spillOversizedToolResults } from '../compaction/spill-oversized.js';
import { takePrecomputedCompaction } from '../compaction/precompute.js';
import { applyRollingReduction } from '@mcp/code-agent/core/compaction/rolling-reduction.js';

export interface CompactingNodeOptions {
  /**
   * Test-only override for the protect-tokens budget. Production code never
   * sets this — `computeProtectTokens(model)` is the source of truth.
   */
  protectTokensOverride?: number;
  /** Test-only override for the maximum preserved tail. */
  maxTailTokensOverride?: number;
  /**
   * Test-only override for the summarize step. Production code passes
   * undefined so `compactWithLLM` falls back to the real `summarizeSpanV3`.
   */
  summarizeOverride?: Parameters<typeof compactWithLLM>[0]['summarize'];
}

export class CompactingNode implements BehaviorNode {
  readonly state = 'Compacting' as const;

  constructor(private readonly nodeOpts: CompactingNodeOptions = {}) {}

  async execute(ctx: RunContext, lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    // A6 — which gate routed us here (loop-aware reason / size gate /
    // context-overflow). Threaded into every history_compacted emission so
    // the dashboard can answer "WHY did this compaction fire?".
    const trigger = lastEvent?.kind === 'TokenThresholdHit' ? lastEvent.trigger : undefined;
    const contextProvider = ctx.opts.provider;
    const summaryProvider = ctx.opts.compactionProvider ?? contextProvider;
    const charsBefore = approxChars(ctx.messages);
    const isMilestone = trigger?.startsWith('milestone:') === true;
    const defaultProtectTokens = computeProtectTokens({
      model: contextProvider.model,
      contextWindow: ctx.opts.contextWindow,
    });
    // Milestones can be queued well before context pressure reaches 90%, but
    // Executing emits them only once a real size gate fires. Keep the semantic
    // boundary's proportional-tail policy distinct from ordinary compaction.
    const estimatedHistoryTokens = Math.max(1, Math.ceil(charsBefore / 4));
    const milestoneProtectTokens = Math.min(
      defaultProtectTokens,
      Math.max(4_000, Math.floor(estimatedHistoryTokens * 0.4)),
    );
    const protectTokens = this.nodeOpts.protectTokensOverride
      ?? (isMilestone ? milestoneProtectTokens : defaultProtectTokens);
    // Ceiling on the preserved tail so a single long user turn (history with
    // < N user messages) can't make recede preserve everything and no-op.
    // Derived from the model window — independent of the protect-tokens override.
    const maxTailTokens = this.nodeOpts.maxTailTokensOverride ?? computeProtectTokens({
        model: contextProvider.model,
        contextWindow: ctx.opts.contextWindow,
        protectRatio: resolveRecedeTailRatio(),
      });
    const effectiveMaxTailTokens = isMilestone
      ? Math.min(maxTailTokens, Math.max(protectTokens, Math.floor(estimatedHistoryTokens * 0.55)))
      : maxTailTokens;
    const attemptId = ctx.opts.sessionStore && ctx.opts.sessionId != null
      ? await ctx.opts.sessionStore.startCompactionAttempt({
          session_id: ctx.opts.sessionId,
          run_id: ctx.runId,
          turn: ctx.turn,
          turn_telemetry_id: ctx.lastTurnTelemetryId,
          trigger: trigger ?? 'context_threshold',
          provider_chain: [summaryProvider, contextProvider]
            .filter((candidate, index, all) => all.findIndex(
              (other) => other.name === candidate.name && other.model === candidate.model,
            ) === index)
            .map((candidate) => ({ provider: candidate.name, model: candidate.model })),
          prompt_tokens_before: estimatedHistoryTokens,
          history_chars_before: charsBefore,
        })
      : null;
    const finishAttempt = async (
      input: Parameters<
        NonNullable<typeof ctx.opts.sessionStore>['finishCompactionAttempt']
      >[2],
    ): Promise<void> => {
      if (!ctx.opts.sessionStore || ctx.opts.sessionId == null) return;
      await ctx.opts.sessionStore.finishCompactionAttempt(
        ctx.opts.sessionId,
        attemptId,
        input,
      );
    };

    let liveState: Parameters<typeof compactWithLLM>[0]['liveState'];
    try {
      const state = ctx.bridge?.getSessionStateData?.() ?? null;
      if (state) {
        liveState = {
          activePlan: state.activePlan,
          // Presence (including an empty list) is intentional: persisted task
          // state is authoritative over model-inferred pending work.
          todos: state.todos.map((todo) => ({
            content: todo.label,
            activeForm: todo.label,
            status: todo.status,
          })),
        };
      }
    } catch {
      liveState = undefined;
    }

    // Perf W1 — consume the background-precomputed summary when its head
    // still matches the live history (see `compaction/precompute.ts`).
    // Milestones use a different protect budget than the precompute assumed,
    // so they always take the inline path and drop any pending slot.
    let precomputed = null;
    if (isMilestone) {
      ctx.summaryPrecompute = null;
    } else if (!this.nodeOpts.summarizeOverride) {
      precomputed = await takePrecomputedCompaction(ctx);
      if (precomputed) {
        console.log(
          `[coder] compaction consumed precomputed summary (head=${precomputed.collapsedFrom} messages)`,
        );
      }
    }
    const result = precomputed ?? await compactWithLLM({
      messages: ctx.messages,
      protectTokens,
      maxTailTokens: effectiveMaxTailTokens,
      summaryProvider,
      fallbackProvider: contextProvider,
      summaryOptions: ctx.opts.compactionSummaryOptions,
      summarize: this.nodeOpts.summarizeOverride,
      liveState,
      // A3 — pass the abort signal so a hung aux provider (during summary
      // call) can be cancelled instead of stalling the whole Compacting node.
      signal: ctx.opts.toolContext.signal,
    });

    if (!result.ok) {
      const attempts = bumpRecovery(ctx, 'compact-failure');
      const cap = recoveryCap('compact-failure');

      ctx.emit('history_compacted', {
        strategy: 'none',
        pruned_messages: 0,
        pruned_chars: 0,
        total_chars_before: charsBefore,
        total_chars_after: charsBefore,
        auto_continue: ctx.autoContinues,
        trigger,
      });

      if (attempts > cap) {
        // Last resort before killing the run: the summarizer is unavailable
        // (cap consecutive failures), but the history may still shrink
        // mechanically — losing the summary is strictly better than losing
        // the run. Abort only when even the deterministic cut is a no-op —
        // or when the "failure" is actually the user's abort signal (a run
        // the user cancelled must not be revived by the fallback).
        const fallback = ctx.opts.toolContext.signal?.aborted
          ? null
          : truncateHeadMechanically({
              messages: ctx.messages,
              protectTokens,
              maxTailTokens: effectiveMaxTailTokens,
            });
        if (fallback && fallback.collapsedFrom > 0) {
          ctx.messages.splice(0, ctx.messages.length, ...fallback.messages);
          flushRollingReductionDurable(ctx);
          ctx.consecutiveNoopCompactions = 0;
          ctx.recovery.set('compact-failure', 0);
          ctx.injectionState.recentCompactionAt = ctx.turn;
          // Checkpoint the loop-aware signals like the summarizer path does,
          // so `cumulative` / `stuck-progress` don't re-fire immediately.
          ctx.cumulativeAtLastCompaction = ctx.cumulativeInputTokens;
          ctx.consecutiveNoTextTurns = 0;
          const charsAfter = approxChars(ctx.messages);
          ctx.emit('history_compacted', {
            strategy: 'deterministic',
            pruned_messages: Math.max(0, fallback.collapsedFrom - fallback.collapsedTo),
            pruned_chars: Math.max(0, charsBefore - charsAfter),
            total_chars_before: charsBefore,
            total_chars_after: charsAfter,
            auto_continue: ctx.autoContinues,
            trigger,
          });
          await finishAttempt({
            status: 'deterministic_fallback',
            strategy: 'deterministic',
            summarizer_ran: true,
            history_chars_after: charsAfter,
            pruned_messages: Math.max(0, fallback.collapsedFrom - fallback.collapsedTo),
            error_message: result.error?.message ?? null,
          });
          if (isMilestone) ctx.bridge?.clearMilestoneCompaction?.();
          return events.compactionDone({
            collapsedFrom: fallback.collapsedFrom,
            collapsedTo: fallback.collapsedTo,
          });
        }

        ctx.emit('recovery_aborted', {
          kind: 'compact-failure',
          attempts,
          cap,
          contextHint: result.error?.message ?? null,
        });
        ctx.stopReason = 'compact_failure';
        ctx.transition = 'compact-pre-turn';
        ctx.error = result.error ?? new Error('Compaction failed');
        await finishAttempt({
          status: 'noop',
          strategy: 'none',
          summarizer_ran: true,
          history_chars_after: charsBefore,
          error_message: result.error?.message ?? 'compaction aborted',
        });
        return events.aborted();
      }

      // Below cap — surface as a retryable provider error so Recovering
      // applies backoff and the loop tries another turn (which may or may
      // not re-cross the token threshold).
      await finishAttempt({
        status: 'noop',
        strategy: 'none',
        summarizer_ran: true,
        history_chars_after: charsBefore,
        error_message: result.error?.message ?? 'summary providers failed',
      });
      return events.providerError({ retryable: true, status: 500 });
    }

    // Fix B — checkpoint the loop-aware compaction signals once we've reached a
    // successful Compacting outcome (whether or not there was a head to
    // collapse). Without this, the `cumulative` / `stuck-progress` branches —
    // which don't shrink just because we compacted — would re-fire next turn
    // and route straight back here, an infinite Compacting loop on the
    // `collapsedFrom === 0` ("nothing to compact") path in particular.
    ctx.cumulativeAtLastCompaction = ctx.cumulativeInputTokens;
    ctx.consecutiveNoTextTurns = 0;

    if (result.collapsedFrom === 0) {
      // P1 — the no-op is usually because a single recent `tool_result` exceeds
      // the protected tail (`cutoff >= length`): the summarizer keeps the tail
      // verbatim, so it can't shrink the block that's blowing the window.
      // Deterministically spill those oversized blocks to the side-file store
      // (recoverable via `get_tool_output`) so the next pass has real room.
      // This is a genuine reduction — NOT the "nothing to do" no-op below.
      const spill = spillOversizedToolResults({
        messages: ctx.messages,
        protectTokens,
        store: ctx.opts.toolContext.toolOutputStore,
      });
      // Require real freed space (not just a touched block) before treating
      // this as a reduction — otherwise a zero-progress spill would keep
      // resetting the no-op streak and starve the pre-emit irreducible bypass.
      if (spill.spilled > 0 && spill.freedChars > 0) {
        ctx.messages.splice(0, ctx.messages.length, ...spill.messages);
        flushRollingReductionDurable(ctx);
        // A real reduction freed space — clear the no-op streak and the
        // compact-failure breaker, same as the summarizer path below.
        ctx.consecutiveNoopCompactions = 0;
        ctx.recovery.set('compact-failure', 0);
        ctx.injectionState.recentCompactionAt = ctx.turn;
        const charsAfter = approxChars(ctx.messages);
        ctx.emit('history_compacted', {
          strategy: 'deterministic',
          pruned_messages: 0,
          pruned_chars: spill.freedChars,
          total_chars_before: charsBefore,
          total_chars_after: charsAfter,
          auto_continue: ctx.autoContinues,
          trigger,
        });
        await finishAttempt({
          status: 'deterministic_fallback',
          strategy: 'deterministic',
          summarizer_ran: false,
          history_chars_after: charsAfter,
          pruned_messages: 0,
          error_message: 'oversized tool result spilled without an LLM summary',
        });
        return events.compactionDone({ collapsedFrom: 0, collapsedTo: 0 });
      }
      // Nothing collapsed AND nothing to spill — either history already fits, or
      // the tail is irreducible by us (e.g. a huge user message). Count
      // consecutive no-ops so the pre-emit / post-turn gates stop re-triggering
      // us forever (the pre-emit gate then sends the request as-is).
      ctx.consecutiveNoopCompactions += 1;
      // Emit a `none` strategy event so the dashboard sees we considered
      // compaction and chose to skip.
      ctx.emit('history_compacted', {
        strategy: 'none',
        pruned_messages: 0,
        pruned_chars: 0,
        total_chars_before: charsBefore,
        total_chars_after: charsBefore,
        auto_continue: ctx.autoContinues,
        trigger,
      });
      await finishAttempt({
        status: 'noop',
        strategy: 'none',
        summarizer_ran: false,
        history_chars_after: charsBefore,
      });
      return events.compactionDone({ collapsedFrom: 0, collapsedTo: 0 });
    }

    // This is the only LLM result for the boundary. Persist the exact object
    // before replacing the head so the host can align it to durable message
    // sequence. A bundle checkpoint failure is non-fatal: the in-memory resume
    // still keeps this run alive and the unchanged boundary can be retried.
    let checkpointStatus: 'summarized' | 'checkpoint_failed' = 'summarized';
    let checkpointChapterId: string | null = null;
    let checkpointBoundarySeq: number | null = null;
    let checkpointError: string | null = null;
    if (result.summary && ctx.opts.onCompactionCheckpoint) {
      try {
        const checkpoint = await ctx.opts.onCompactionCheckpoint({
          summary: result.summary,
          headMessages: ctx.messages.slice(0, result.cutoffApplied),
          trigger,
          autoContinues: ctx.autoContinues,
        });
        checkpointChapterId = checkpoint.chapterId ?? null;
        checkpointBoundarySeq = checkpoint.boundaryId ?? null;
        if (checkpoint.status === 'failed' || checkpoint.status === 'noop') {
          checkpointStatus = 'checkpoint_failed';
          checkpointError = checkpoint.reason ?? `checkpoint ${checkpoint.status}`;
        }
      } catch (error) {
        checkpointStatus = 'checkpoint_failed';
        checkpointError = error instanceof Error ? error.message : String(error);
        console.warn(
          `[coder] compaction checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Preserve the shared backing array passed by CoderRunner. Reassignment
    // would leave host observers holding the pre-compaction transcript.
    ctx.messages.splice(0, ctx.messages.length, ...result.messages);
    flushRollingReductionDurable(ctx);
    // A real compaction freed space — clear the no-op streak.
    ctx.consecutiveNoopCompactions = 0;
    // Reset the compact-failure counter on a clean run — the circuit
    // breaker should fire only on CONSECUTIVE failures.
    ctx.recovery.set('compact-failure', 0);
    // PR-F dynamic injection — mark the compaction so the next Executing
    // turn renders a "context summarized" reminder. Carries for ≤2 turns
    // (clamped inside the dynamic-injection helper) then auto-clears.
    ctx.injectionState.recentCompactionAt = ctx.turn;

    const charsAfter = approxChars(ctx.messages);
    ctx.emit('history_compacted', {
      strategy: 'summarizer',
      pruned_messages: Math.max(0, result.collapsedFrom - result.collapsedTo),
      pruned_chars: Math.max(0, charsBefore - charsAfter),
      total_chars_before: charsBefore,
      total_chars_after: charsAfter,
      auto_continue: ctx.autoContinues,
      trigger,
    });
    await finishAttempt({
      status: checkpointStatus,
      strategy: 'summarizer',
      summarizer_ran: true,
      summary_provider: result.summaryProviderName ?? summaryProvider.name,
      summary_model: result.summaryModel ?? summaryProvider.model,
      history_chars_after: charsAfter,
      pruned_messages: Math.max(0, result.collapsedFrom - result.collapsedTo),
      chapter_id: checkpointChapterId,
      boundary_seq: checkpointBoundarySeq,
      error_message: checkpointError ?? (result.attemptErrors?.join(' | ') || null),
    });
    if (isMilestone) ctx.bridge?.clearMilestoneCompaction?.();

    return events.compactionDone({
      collapsedFrom: result.collapsedFrom,
      collapsedTo: result.collapsedTo,
    });
  }
}

/**
 * Perf W1 — durable rolling-reduction flush. The per-turn view now DEFERS
 * every retirement (cache contract in `core/runner.ts`): the only place they
 * land is here, right after a compaction rewrote the prefix anyway. Runs on
 * the post-compaction array (the head is the synthetic summary, so this is
 * effectively tail-local) and preserves the shared backing array.
 */
function flushRollingReductionDurable(ctx: RunContext): void {
  const rolled = applyRollingReduction(ctx.messages, { flushThresholdChars: 0 });
  if (rolled.reduced > 0) {
    ctx.messages.splice(0, ctx.messages.length, ...rolled.messages);
    console.log(
      `[coder] durable reducer flush retired ${rolled.reduced} stale tool_result(s) ` +
        `(~${rolled.freedChars} chars) at compaction`,
    );
  }
}

/**
 * Cheap byte-size estimate of the history for telemetry. Mirrors the
 * `approxChars` helper in `runner/pure-helpers.ts` but inlined here so the
 * node has no inbound dependency on the runner public surface.
 */
function approxChars(messages: { content: unknown }[]): number {
  let total = 0;
  for (const m of messages) {
    total += JSON.stringify(m.content).length;
  }
  return total;
}
