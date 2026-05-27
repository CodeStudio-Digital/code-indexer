/**
 * Recovering node — provider retry / fallback / refresh paths. Receives the
 * `ProviderError` event that caused the transition INTO this node, classifies
 * it into a `RecoveryKind`, bumps the per-kind circuit-breaker counter, and
 * either yields back to Executing (after backoff) or aborts the run.
 *
 * Classification heuristic:
 *   - 401          → provider-401-refresh
 *   - 400          → provider-400-retry
 *   - 429 / 5xx    → provider-transient-retry  (default)
 *   - non-retryable → straight Aborted, no counter bump
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
import { backoffDelayMs } from '../provider-retry.js';
import { recoveryCap, type RecoveryKind } from '../recovery-config.js';

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

    if (!lastEvent.retryable) {
      ctx.stopReason = 'error';
      ctx.transition = classifyTransition(lastEvent.status);
      ctx.error = new Error(`Provider returned non-retryable status ${lastEvent.status}`);
      return events.aborted();
    }

    const kind = classifyKind(lastEvent.status);
    const attempts = bumpRecovery(ctx, kind);
    const cap = recoveryCap(kind);

    if (attempts > cap) {
      ctx.emit('recovery_aborted', {
        kind,
        attempts,
        cap,
        contextHint: `status=${lastEvent.status}`,
      });
      ctx.stopReason = 'recovery_capped';
      ctx.transition = classifyTransition(lastEvent.status);
      ctx.error = new Error(
        `Recovery cap exceeded: kind=${kind} attempts=${attempts}/${cap}`,
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

/** Map an HTTP-ish status to the recovery kind whose counter we bump. */
function classifyKind(status: number): RecoveryKind {
  if (status === 401) return 'provider-401-refresh';
  if (status === 400) return 'provider-400-retry';
  return 'provider-transient-retry';
}

/**
 * Mirror of `classifyKind` returning a `TransitionKind` (the wider union used
 * by `RunResult.transition`). Kept separate from `classifyKind` because the
 * recovery-counter map only accepts `RecoveryKind`, while `ctx.transition`
 * accepts the full `TransitionKind` (which includes doom-loop / pre-read /
 * stop-guard reasons that don't drive circuit breakers).
 */
function classifyTransition(status: number): import('../types.js').TransitionKind {
  if (status === 401) return 'provider-401-refresh';
  if (status === 400) return 'provider-400-retry';
  return 'provider-transient-retry';
}
