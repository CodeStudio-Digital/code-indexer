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

export interface CompactingNodeOptions {
  /**
   * Test-only override for the protect-tokens budget. Production code never
   * sets this — `computeProtectTokens(model)` is the source of truth.
   */
  protectTokensOverride?: number;
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
    const protectTokens = this.nodeOpts.protectTokensOverride
      ?? computeProtectTokens({ model: contextProvider.model });
    // Ceiling on the preserved tail so a single long user turn (history with
    // < N user messages) can't make recede preserve everything and no-op.
    // Derived from the model window — independent of the protect-tokens override.
    const maxTailTokens = computeProtectTokens({
      model: contextProvider.model,
      protectRatio: resolveRecedeTailRatio(),
    });
    const charsBefore = approxChars(ctx.messages);

    let liveState: Parameters<typeof compactWithLLM>[0]['liveState'];
    try {
      const state = ctx.bridge?.getSessionStateData?.() ?? null;
      if (state) {
        liveState = {
          goal: state.goal,
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

    const result = await compactWithLLM({
      messages: ctx.messages,
      protectTokens,
      maxTailTokens,
      summaryProvider,
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
              maxTailTokens,
            });
        if (fallback && fallback.collapsedFrom > 0) {
          ctx.messages.splice(0, ctx.messages.length, ...fallback.messages);
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
        return events.aborted();
      }

      // Below cap — surface as a retryable provider error so Recovering
      // applies backoff and the loop tries another turn (which may or may
      // not re-cross the token threshold).
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
      return events.compactionDone({ collapsedFrom: 0, collapsedTo: 0 });
    }

    // This is the only LLM result for the boundary. Persist the exact object
    // before replacing the head so the host can align it to durable message
    // ids. A DB failure is non-fatal: the in-memory resume still keeps this run
    // alive and the unchanged boundary can be retried later.
    if (result.summary && ctx.opts.onCompactionCheckpoint) {
      try {
        await ctx.opts.onCompactionCheckpoint({
          summary: result.summary,
          headMessages: ctx.messages.slice(0, result.cutoffApplied),
          trigger,
          autoContinues: ctx.autoContinues,
        });
      } catch (error) {
        console.warn(
          `[coder] compaction checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Preserve the shared backing array passed by CoderRunner. Reassignment
    // would leave host observers holding the pre-compaction transcript.
    ctx.messages.splice(0, ctx.messages.length, ...result.messages);
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

    return events.compactionDone({
      collapsedFrom: result.collapsedFrom,
      collapsedTo: result.collapsedTo,
    });
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
