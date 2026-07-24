/**
 * Recovering node — provider retry / fallback / refresh paths. Receives the
 * `ProviderError` event that caused the transition INTO this node, classifies
 * it into a `RecoveryKind`, bumps the per-kind circuit-breaker counter, and
 * either yields back to Executing (after backoff) or aborts the run.
 *
 * Classification heuristic:
 *   - 401          → provider-401-refresh
 *   - 400          → provider-400-retry
 *   - 0 (no status)→ provider-unknown-retry  (low cap; connection/mid-stream)
 *   - 429 / 5xx    → provider-transient-retry  (default)
 *   - non-retryable → straight Aborted, no counter bump (uses the real
 *                     provider message from the event when present)
 *
 * Backoff: exp+jitter via `backoffDelayMs` (lifted from `provider-retry.ts`
 * so the BT shares the same curve as the legacy loop).
 *
 * Caps come from `recoveryCap(kind)` which reads `CODER_RECOVERY_*_MAX` env
 * vars at call time, so tests can override after import.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import { events } from '../machine/events.js';
import { bumpRecovery } from '../machine/context.js';
import { backoffDelayMs, isContextOverflowError } from '../provider-retry.js';
import {
  recoveryCap,
  transientRetryMaxPerTurn,
  type RecoveryKind,
} from '../recovery-config.js';

export class RecoveringNode implements BehaviorNode {
  readonly state = 'Recovering' as const;

  async execute(ctx: RunContext, lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    if (!lastEvent || lastEvent.kind !== 'ProviderError') {
      // Defensive: orchestrator should always route here with a ProviderError,
      // but if not, abort with a clear signal rather than spinning silently.
      ctx.stopReason = 'error';
      ctx.transition = 'provider-transient-retry';
      ctx.error = new Error('Recovering invoked without ProviderError context');
      return events.aborted();
    }

    // Context-window overflow is deterministic — retrying the same payload
    // (or aborting on the 400) is always wrong. Route to Compacting so the
    // history shrinks before the next provider call. Checked BEFORE the
    // retryable gate: overflow 400s arrive as retryable:false, and the
    // status-less mid-stream variant (status 0) would otherwise blind-retry.
    if (isContextOverflowError(lastEvent.message, lastEvent.code)) {
      const attempts = bumpRecovery(ctx, 'context-overflow');
      const cap = recoveryCap('context-overflow');
      if (attempts > cap) {
        ctx.emit('recovery_aborted', {
          kind: 'context-overflow',
          attempts,
          cap,
          contextHint: `status=${lastEvent.status}${lastEvent.message ? ` message=${lastEvent.message}` : ''}`,
        });
        ctx.stopReason = 'compact_exhausted';
        ctx.transition = classifyTransition(lastEvent.status, lastEvent.code);
        ctx.error = new Error(
          `Context overflow persisted after ${cap} compaction round-trips: ` +
            (lastEvent.message ?? `status ${lastEvent.status}`),
        );
        return events.aborted();
      }
      return events.tokenThresholdHit({ ratio: 1, trigger: 'context-overflow' });
    }

    if (!lastEvent.retryable) {
      ctx.stopReason = 'error';
      ctx.transition = classifyTransition(lastEvent.status, lastEvent.code);
      ctx.error = new Error(
        lastEvent.message ?? `Provider returned non-retryable status ${lastEvent.status}`,
      );
      return events.aborted();
    }

    const kind = classifyKind(lastEvent.status, lastEvent.code);
    const attempts = bumpRecovery(ctx, kind);
    const cap = recoveryCap(kind);

    // R5's per-logical-call bound used to exist only as an unused config
    // function. Enforce it before the much larger run-lifetime circuit breaker
    // so one persistent 429 cannot consume the entire cap in a single turn.
    if (kind === 'provider-transient-retry') {
      ctx.transientRetriesThisTurn += 1;
      const turnCap = transientRetryMaxPerTurn();
      if (ctx.transientRetriesThisTurn > turnCap) {
        ctx.emit('recovery_aborted', {
          kind,
          attempts: ctx.transientRetriesThisTurn,
          cap: turnCap,
          contextHint:
            `per-turn status=${lastEvent.status}` +
            `${lastEvent.message ? ` message=${lastEvent.message}` : ''}`,
        });
        ctx.stopReason = 'recovery_capped';
        ctx.transition = classifyTransition(lastEvent.status, lastEvent.code);
        ctx.error = new Error(
          `Per-turn transient retry cap exceeded ` +
          `(${ctx.transientRetriesThisTurn}/${turnCap}): ` +
          (lastEvent.message ?? `status ${lastEvent.status}`),
        );
        return events.aborted();
      }
    }

    if (attempts > cap) {
      ctx.emit('recovery_aborted', {
        kind,
        attempts,
        cap,
        contextHint: `status=${lastEvent.status}${lastEvent.message ? ` message=${lastEvent.message}` : ''}`,
      });
      ctx.stopReason = 'recovery_capped';
      ctx.transition = classifyTransition(lastEvent.status, lastEvent.code);
      ctx.error = new Error(
        `Recovery cap exceeded (kind=${kind} ${attempts}/${cap}): ` +
          (lastEvent.message ?? `status ${lastEvent.status}`),
      );
      return events.aborted();
    }

    const delay = backoffDelayMs(attempts);
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    return events.turnSucceeded({ hasToolCalls: false });
  }
}

/** Map an HTTP-ish status (+ optional error code) to the recovery kind whose counter we bump. */
function classifyKind(status: number, code?: string): RecoveryKind {
  if (status === 401) return 'provider-401-refresh';
  if (status === 400) return 'provider-400-retry';
  if (status === 0) {
    // Our thinking-only watchdog gets its own budget-doubling bucket; every
    // other status-less error (connection/mid-stream/parse) stays low-cap.
    if (code === 'THINKING_TIMEOUT') return 'provider-thinking-timeout';
    return 'provider-unknown-retry';
  }
  return 'provider-transient-retry';
}

/**
 * Mirror of `classifyKind` returning a `TransitionKind` (the wider union used
 * by `RunResult.transition`). Kept separate from `classifyKind` because the
 * recovery-counter map only accepts `RecoveryKind`, while `ctx.transition`
 * accepts the full `TransitionKind` (which includes doom-loop / pre-read /
 * stop-guard reasons that don't drive circuit breakers).
 */
function classifyTransition(status: number, code?: string): import('../types.js').TransitionKind {
  if (status === 401) return 'provider-401-refresh';
  if (status === 400) return 'provider-400-retry';
  if (status === 0 && code === 'THINKING_TIMEOUT') return 'provider-thinking-timeout';
  return 'provider-transient-retry';
}
