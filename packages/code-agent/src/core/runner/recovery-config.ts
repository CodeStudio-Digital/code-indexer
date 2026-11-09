/**
 * Per-recovery-path circuit breaker (PR-2, R1 from
 * docs/agent-research/COMPARISON.md). Each recovery KIND has its own
 * lifetime cap so a misbehaving server can't repeatedly trigger the same
 * recovery path and balloon billing. Counts persist for the entire session
 * (not reset on turn boundary) — the abuse pattern we are blocking is
 * "this session has burned 6 OAuth refreshes, something is wrong".
 *
 * Distinct from the per-turn `transientRetries` counter that drives R5's
 * exp+jitter retry — a single turn may issue a few transient retries; the
 * circuit breaker only fires when this happens turn after turn.
 */
export const RECOVERY_KINDS = [
  'provider-400-retry',
  'provider-401-refresh',
  'provider-transient-retry',
  'provider-unknown-retry',
  'provider-transport-retry',
  'provider-thinking-timeout',
  'provider-fallback',
  'compact-failure',
  'context-overflow',
] as const;
export type RecoveryKind = typeof RECOVERY_KINDS[number];

/**
 * Recovery caps are product invariants. Keeping them together makes the
 * circuit-breaker policy reviewable without exposing process-wide switches.
 */
export const RECOVERY_CAP_DEFAULTS: Record<RecoveryKind, number> = {
  'provider-400-retry': 3,
  'provider-401-refresh': 2,
  // Transient (429/5xx/timeout) — large cap because R5 already bounds per
  // turn; this catches "every turn for 20 turns gets one 429".
  'provider-transient-retry': 30,
  // Status-less errors (connection drop / mid-stream / parse). Unlike a true
  // 5xx these usually repeat identically, so a small cap fails fast (~4
  // attempts / <1min) with the real message instead of looping ~5min.
  'provider-unknown-retry': 4,
  // Transport failures have a consecutive bound, reset only after a committed
  // usable response. They ALSO share the existing transient run budget (30).
  'provider-transport-retry': 4,
  // Legacy provider/plugin errors may still carry THINKING_TIMEOUT. The host
  // no longer imposes a wall-clock deadline on an active reasoning stream.
  'provider-thinking-timeout': 2,
  'provider-fallback': 5,
  'compact-failure': 3,
  // Overflow → Compacting round-trips. Each attempt SHOULD shrink the
  // history; if 3 compactions still overflow, the context is irreducible.
  'context-overflow': 3,
};
export function recoveryCap(kind: RecoveryKind): number {
  return RECOVERY_CAP_DEFAULTS[kind];
}

/**
 * PR-3 (R4): how many user-message turns to keep raw past the compaction
 * boundary. Mirrors kimi-cli's `max_preserved_messages=2` with the
 * telemetry-proven local posture of four turns.
 */
export function preserveLastNTurns(): number {
  return 4;
}

/**
 * Tenacity-style exp+jitter backoff (PR-2, R5 from
 * docs/agent-research/COMPARISON.md). Mirrors kimi-cli's
 * `wait_exponential_jitter(initial=0.3, max=5, jitter=0.5)`. Returns a
 * delay in milliseconds for the given 1-based attempt number.
 *
 */
export function transientRetryMaxPerTurn(): number {
  return 3;
}
export function transientRetryInitialMs(): number {
  return 300;
}
export function transientRetryMaxMs(): number {
  return 5000;
}
export function transientRetryJitter(): number {
  return 0.5;
}
