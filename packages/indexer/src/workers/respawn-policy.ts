/**
 * Respawn policy for worker pools: exponential backoff between crash
 * respawns, and a degraded state after too many consecutive crashes.
 *
 * Pure decision logic — no timers, no workers — so the pool stays testable
 * without spawning threads. The pool reports `onCrash()` for every
 * unexpected worker exit and `onHealthy()` on the first successful response
 * after a (re)spawn; `degraded` means "stop respawning, surface a clear
 * error" (recovery = close + recreate the pool singleton).
 */

export interface RespawnPolicyOptions {
  /** First retry delay; doubles per consecutive failure. Default 250ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 10s. */
  maxDelayMs?: number;
  /** Consecutive crashes that flip the pool to degraded. Default 5. */
  maxConsecutiveFailures?: number;
}

export type RespawnDecision =
  | { kind: 'respawn'; delayMs: number }
  | { kind: 'degraded' };

export interface RespawnPolicy {
  onCrash(): RespawnDecision;
  /** A worker answered successfully — the crash streak is over. */
  onHealthy(): void;
  isDegraded(): boolean;
  consecutiveFailures(): number;
}

export function createRespawnPolicy(opts: RespawnPolicyOptions = {}): RespawnPolicy {
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 10_000;
  const cap = opts.maxConsecutiveFailures ?? 5;
  let failures = 0;
  let degraded = false;

  return {
    onCrash(): RespawnDecision {
      failures++;
      if (failures >= cap) {
        degraded = true;
        return { kind: 'degraded' };
      }
      return { kind: 'respawn', delayMs: Math.min(base * 2 ** (failures - 1), max) };
    },
    onHealthy(): void {
      if (!degraded) failures = 0;
    },
    isDegraded(): boolean {
      return degraded;
    },
    consecutiveFailures(): number {
      return failures;
    },
  };
}
