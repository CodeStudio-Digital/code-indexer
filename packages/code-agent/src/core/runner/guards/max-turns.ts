/**
 * Max-turns guard + auto-continue policy.
 *
 * Behavior (mirrors the legacy loop in runner.ts:2425+):
 *   - Below the current batch ceiling `maxTurns × (1 + autoContinues)`:
 *     continue normally.
 *   - At the ceiling with `autoContinues < MAX_AUTO_CONTINUES`: auto-extend
 *     by one batch of `maxTurns` turns (15 extra batches by default, owned by
 *     the session rather than by a process environment variable, so
 *     the total budget is `maxTurns × (1 + cap)`). The checkpoint fires once
 *     per batch boundary — NOT on every turn past the first `maxTurns`.
 *   - Otherwise: stop with `MaxTurnsReached` → Reviewing.
 */

/**
 * Default auto-continue cap per run.
 *
 * Session-owned auto-continue cap. Use cases:
 *   - 0  → disable auto-continue (hard stop at maxTurns).
 *   - 15 → default; total turn budget = maxTurns × (1 + 15) = 16×maxTurns.
 *   - >15 → for extremely long sessions where you've validated the agent
 *          won't run away. Combined with the BT's other guards (tuple-hash
 *          dedup, doom-loop, dominance), the practical ceiling is the
 *          provider's tokens-per-minute budget, not this counter.
 */
import { DEFAULT_SESSION_MAX_AUTO_CONTINUES } from '../../../sessions/run-limits.js';

/** Legacy helper retained for callers/tests; no longer reads process.env. */
export function maxAutoContinues(): number {
  return DEFAULT_SESSION_MAX_AUTO_CONTINUES;
}

export interface MaxTurnsState {
  /** Turn just completed. */
  turn: number;
  /** Auto-continues consumed so far. */
  autoContinues: number;
  /** Positive, explicitly enabled cap from `RunnerOptions.maxTurns`. */
  maxTurns: number;
}

export type MaxTurnsVerdict =
  | { kind: 'continue' }
  | { kind: 'auto-continue'; nextCount: number }
  | { kind: 'stop' };

export function checkMaxTurns(
  state: MaxTurnsState,
  autoContinueCap = maxAutoContinues(),
): MaxTurnsVerdict {
  // Each consumed auto-continue grants a fresh batch of `maxTurns` turns, so
  // the effective ceiling grows with `autoContinues`. We only auto-continue
  // (and emit the user-facing checkpoint) when CROSSING each batch boundary —
  // not on every turn past the first `maxTurns`, which would otherwise burn
  // the whole auto-continue budget one turn at a time.
  const effectiveLimit = state.maxTurns * (1 + state.autoContinues);
  if (state.turn < effectiveLimit) return { kind: 'continue' };
  if (state.autoContinues < autoContinueCap) {
    return { kind: 'auto-continue', nextCount: state.autoContinues + 1 };
  }
  return { kind: 'stop' };
}
