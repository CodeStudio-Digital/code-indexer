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
  'provider-fallback',
  'compact-failure',
] as const;
export type RecoveryKind = typeof RECOVERY_KINDS[number];

/**
 * Caps are read lazily from env each time tryRecord runs so tests can
 * mutate process.env after the runner module is loaded. Defaults below.
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
  'provider-fallback': 5,
  'compact-failure': 3,
};
const RECOVERY_CAP_ENV_KEYS: Record<RecoveryKind, string> = {
  'provider-400-retry': 'CODER_RECOVERY_400_MAX',
  'provider-401-refresh': 'CODER_RECOVERY_401_MAX',
  'provider-transient-retry': 'CODER_RECOVERY_TRANSIENT_MAX',
  'provider-unknown-retry': 'CODER_RECOVERY_UNKNOWN_MAX',
  'provider-fallback': 'CODER_RECOVERY_FALLBACK_MAX',
  'compact-failure': 'CODER_RECOVERY_COMPACT_MAX',
};
export function recoveryCap(kind: RecoveryKind): number {
  const envVal = process.env[RECOVERY_CAP_ENV_KEYS[kind]];
  if (envVal != null && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return RECOVERY_CAP_DEFAULTS[kind];
}

/**
 * PR-3 (R4): how many user-message turns to keep raw past the compaction
 * boundary. Mirrors kimi-cli's `max_preserved_messages=2`. Lazy-resolved
 * so tests can override post-import.
 */
export function preserveLastNTurns(): number {
  const v = process.env.CODER_COMPACT_PRESERVE_LAST_N_TURNS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2;
}

/**
 * Tenacity-style exp+jitter backoff (PR-2, R5 from
 * docs/agent-research/COMPARISON.md). Mirrors kimi-cli's
 * `wait_exponential_jitter(initial=0.3, max=5, jitter=0.5)`. Returns a
 * delay in milliseconds for the given 1-based attempt number.
 *
 * Read lazily so tests can override after import.
 */
export function transientRetryMaxPerTurn(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 3;
}
export function transientRetryInitialMs(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_INITIAL_MS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 300;
}
export function transientRetryMaxMs(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_MAX_MS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 5000;
}
export function transientRetryJitter(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_JITTER;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0.5;
}
