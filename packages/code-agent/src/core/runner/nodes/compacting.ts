/**
 * Compacting node — LLM-based context summarization. Entered after Executing
 * emits `TokenThresholdHit`. Delegates the heavy lifting to
 * `compactWithLLM`, then either yields `CompactionDone` so Reviewing can
 * sanity-check the new history, or bumps the `compact-failure` counter and
 * routes to Recovering via `ProviderError`.
 *
 * Strategy (per the BT plan §3):
 *   - cutoff via `computeCutoffIndexByTokens` with protect = 40% of effective
 *     context window, then snap to preserve tool pairs and recede to keep
 *     the last N user turns verbatim (Kimi-style).
 *   - summarize the head via the aux model (same provider for now;
 *     follow-up commit can swap to a dedicated cheap model).
 *   - replace head with a single synthetic `user` message rendered from
 *     the CompactionSummaryV2 (tagged blocks).
 *
 * On failure, the `compact-failure` circuit breaker (`recoveryCap=3` by
 * default) eventually aborts the run with `stopReason='compact_failure'`.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import { events } from '../machine/events.js';
import { bumpRecovery } from '../machine/context.js';
import { recoveryCap } from '../recovery-config.js';
import { compactWithLLM } from '../compaction/llm-compactor.js';
import { computeProtectTokens } from '../compaction/threshold.js';

export interface CompactingNodeOptions {
  /**
   * Test-only override for the protect-tokens budget. Production code never
   * sets this — `computeProtectTokens(model)` is the source of truth.
   */
  protectTokensOverride?: number;
  /**
   * Test-only override for the summarize step. Production code passes
   * undefined so `compactWithLLM` falls back to the real `summarizeSpanV2`.
   */
  summarizeOverride?: Parameters<typeof compactWithLLM>[0]['summarize'];
}

export class CompactingNode implements BehaviorNode {
  readonly state = 'Compacting' as const;

  constructor(private readonly nodeOpts: CompactingNodeOptions = {}) {}

  async execute(ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    const summaryProvider = ctx.opts.provider;
    const protectTokens = this.nodeOpts.protectTokensOverride
      ?? computeProtectTokens({ model: summaryProvider.model });
    const charsBefore = approxChars(ctx.messages);

    const result = await compactWithLLM({
      messages: ctx.messages,
      protectTokens,
      summaryProvider,
      summarize: this.nodeOpts.summarizeOverride,
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
      });

      if (attempts > cap) {
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

    if (result.collapsedFrom === 0) {
      // Nothing to do — history already fits. Emit a `none` strategy event
      // so the dashboard sees we considered compaction and chose to skip.
      ctx.emit('history_compacted', {
        strategy: 'none',
        pruned_messages: 0,
        pruned_chars: 0,
        total_chars_before: charsBefore,
        total_chars_after: charsBefore,
        auto_continue: ctx.autoContinues,
      });
      return events.compactionDone({ collapsedFrom: 0, collapsedTo: 0 });
    }

    ctx.messages = result.messages;
    // Reset the compact-failure counter on a clean run — the circuit
    // breaker should fire only on CONSECUTIVE failures.
    ctx.recovery.set('compact-failure', 0);

    const charsAfter = approxChars(ctx.messages);
    ctx.emit('history_compacted', {
      strategy: 'summarizer',
      pruned_messages: Math.max(0, result.collapsedFrom - result.collapsedTo),
      pruned_chars: Math.max(0, charsBefore - charsAfter),
      total_chars_before: charsBefore,
      total_chars_after: charsAfter,
      auto_continue: ctx.autoContinues,
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
