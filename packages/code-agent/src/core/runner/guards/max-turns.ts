/**
 * Max-turns guard + auto-continue policy.
 *
 * Behavior (mirrors the legacy loop in runner.ts:2425+):
 *   - Below `maxTurns`: continue normally.
 *   - At `maxTurns` with `autoContinues < MAX_AUTO_CONTINUES`: auto-extend
 *     by one batch (default 3 extra batches per run).
 *   - Otherwise: stop with `MaxTurnsReached` → Reviewing.
 */

/**
 * Default auto-continue cap per run.
 *
 * Frente E — tunable via `CODER_MAX_AUTO_CONTINUES`. Use cases:
 *   - 0  → disable auto-continue (hard stop at maxTurns).
 *   - 3  → default; total turn budget = maxTurns × (1 + 3) = 4×maxTurns.
 *   - >3 → for extremely long sessions where you've validated the agent
 *          won't run away. Combined with the BT's other guards (tuple-hash
 *          dedup, doom-loop, dominance), the practical ceiling is the
 *          provider's tokens-per-minute budget, not this counter.
 */
export function maxAutoContinues(): number {
  const v = process.env.CODER_MAX_AUTO_CONTINUES;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 3;
}

export interface MaxTurnsState {
  /** Turn just completed. */
  turn: number;
  /** Auto-continues consumed so far. */
  autoContinues: number;
  /** Hard cap from `RunnerOptions.maxTurns` (default 50). */
  maxTurns: number;
}

export type MaxTurnsVerdict =
  | { kind: 'continue' }
  | { kind: 'auto-continue'; nextCount: number }
  | { kind: 'stop' };

export function checkMaxTurns(state: MaxTurnsState): MaxTurnsVerdict {
  if (state.turn < state.maxTurns) return { kind: 'continue' };
  const cap = maxAutoContinues();
  if (state.autoContinues < cap) {
    return { kind: 'auto-continue', nextCount: state.autoContinues + 1 };
  }
  return { kind: 'stop' };
}
