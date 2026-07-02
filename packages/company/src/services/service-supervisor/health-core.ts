/**
 * ServiceSupervisor health core — PURE decision logic (no I/O, no timers,
 * no env reads outside the injected bag). Mirrors the dispatch-core.ts
 * pattern: the supervisor loop feeds probe facts in, gets verdicts out.
 *
 * Health vocabulary (owner decision, company B3):
 *   - HTTP 2xx–4xx            ⇒ healthy   (dev servers 3xx/4xx on '/' a lot)
 *   - container up, HTTP 5xx
 *     or no HTTP reply        ⇒ degraded
 *   - port closed / container
 *     dead / exited           ⇒ down
 *
 * Auto-restart policy: default ON (`MCP_SERVICE_AUTO_RESTART='0'` kills),
 * fires ONLY on `down` (never `degraded`), backoff 5s/15s/45s between
 * consecutive attempts, max 3 attempts per 10min window → incident.
 */

export type HealthState = 'unknown' | 'healthy' | 'degraded' | 'down';

/** Facts one probe pass gathered. All fields optional — a driver hiccup
 *  yields an empty outcome, which keeps the previous state. */
export interface ProbeOutcome {
  /** Status of the HTTP reply, when one arrived (any code counts as a reply). */
  httpStatus?: number;
  /** TCP fallback: is the host port accepting connections? */
  portListening?: boolean;
  /** Container runtime check: false = stopped/exited/gone. */
  containerRunning?: boolean;
  /** Human-readable evidence (exit code, OOM flag, HTTP status…). */
  detail?: string;
}

export interface HealthVerdict {
  next: HealthState;
  changed: boolean;
  detail?: string;
}

/** Map one probe outcome to the next health state. */
export function evaluateProbe(probe: ProbeOutcome, prev: HealthState): HealthVerdict {
  const next = classify(probe);
  if (next === null) {
    // Probe learned nothing (driver error on every channel) — hold state.
    return { next: prev, changed: false, detail: probe.detail };
  }
  return { next, changed: next !== prev, detail: probe.detail };
}

function classify(probe: ProbeOutcome): HealthState | null {
  if (probe.containerRunning === false) return 'down';
  if (probe.httpStatus !== undefined) {
    return probe.httpStatus >= 200 && probe.httpStatus < 500 ? 'healthy' : 'degraded';
  }
  if (probe.portListening !== undefined) {
    // Port open but HTTP not replying: process alive, app wedged.
    return probe.portListening ? 'degraded' : 'down';
  }
  return null;
}

// ─── Restart decision ─────────────────────────────────────────────

export interface RestartAttempt {
  atMs: number;
}

export interface RestartPolicy {
  /** Master kill-switch (env `MCP_SERVICE_AUTO_RESTART`, default ON). */
  enabled: boolean;
  /** Attempts allowed inside `windowMs` before escalating. */
  maxAttempts: number;
  /** Sliding window the attempts are counted in. */
  windowMs: number;
  /** Required gap AFTER the n-th attempt before the next one (5s/15s/45s). */
  backoffMs: readonly number[];
}

export const DEFAULT_RESTART_BACKOFF_MS = [5_000, 15_000, 45_000] as const;
export const DEFAULT_RESTART_LIMIT = 3;
export const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000;

/** Default-ON kill-switch, same parsing posture as autonomy-config. */
function envFlagDefaultOn(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Resolve the effective policy from env (injectable for tests). */
export function resolveRestartPolicy(env: NodeJS.ProcessEnv): RestartPolicy {
  return {
    enabled: envFlagDefaultOn(env.MCP_SERVICE_AUTO_RESTART),
    maxAttempts: envInt(env.MCP_SERVICE_RESTART_LIMIT, DEFAULT_RESTART_LIMIT),
    windowMs: envInt(env.MCP_SERVICE_RESTART_WINDOW_MS, DEFAULT_RESTART_WINDOW_MS),
    backoffMs: DEFAULT_RESTART_BACKOFF_MS,
  };
}

export type SupervisorAction = 'none' | 'restart' | 'incident';

/**
 * Decide what to do about a service in `state`, given its restart history.
 *
 * Semantics:
 *   - anything but `down`      → 'none' (degraded never auto-restarts)
 *   - window exhausted (>= max recent attempts) → 'incident'
 *   - no recent attempt        → 'restart' (first restart is immediate)
 *   - else wait `backoffMs[n-1]` after the n-th attempt before the next
 *
 * The `enabled`/frozen gates are the CALLER's job — this stays a pure
 * function of (state, attempts, now, policy) so the backoff/window math
 * is unit-testable in isolation.
 */
export function decideAction(
  state: HealthState,
  attempts: readonly RestartAttempt[],
  nowMs: number,
  policy: RestartPolicy,
): SupervisorAction {
  if (state !== 'down') return 'none';
  const recent = attempts.filter((a) => nowMs - a.atMs <= policy.windowMs && a.atMs <= nowMs);
  if (recent.length >= policy.maxAttempts) return 'incident';
  if (recent.length === 0) return 'restart';
  const lastAt = Math.max(...recent.map((a) => a.atMs));
  const backoff =
    policy.backoffMs[Math.min(recent.length - 1, policy.backoffMs.length - 1)] ?? 0;
  return nowMs - lastAt >= backoff ? 'restart' : 'none';
}

/** Drop attempts that fell out of the window (keeps per-service arrays bounded). */
export function pruneAttempts(
  attempts: readonly RestartAttempt[],
  nowMs: number,
  windowMs: number,
): RestartAttempt[] {
  return attempts.filter((a) => nowMs - a.atMs <= windowMs);
}
