/**
 * B7 — in-memory per-run counter of CONSECUTIVE `sidecar_down` spec
 * failures. Lives module-level in whatever process mounts the
 * test-event route (main http-api); state is intentionally ephemeral —
 * a restart forgetting the counters is harmless because the watchdog /
 * ChromeService hook still catch dead runs.
 *
 * Contract used by the route:
 *   - every classified `sidecar_down` failure → `trackSidecarFailure`
 *     returns the new consecutive count;
 *   - any other event for the run (pass, ordinary failure, completed)
 *     → `resetSidecarTracker`;
 *   - count >= SIDECAR_DOWN_THRESHOLD ⇒ the route completes the run
 *     early with `error_class='sidecar_down'` and MUST call
 *     `clearSidecarTracker` afterwards (cleanup so the Map never grows
 *     unbounded across runs).
 */

export const SIDECAR_DOWN_THRESHOLD = 2;

const counters = new Map<number, number>();

/** Record one sidecar-down failure; returns the consecutive count. */
export function trackSidecarFailure(runId: number): number {
  const next = (counters.get(runId) ?? 0) + 1;
  counters.set(runId, next);
  return next;
}

/** Reset the streak (a non-sidecar event arrived) without forgetting the run. */
export function resetSidecarTracker(runId: number): void {
  if (counters.has(runId)) counters.set(runId, 0);
}

/** Drop the run entirely (run completed / early-terminated). */
export function clearSidecarTracker(runId: number): void {
  counters.delete(runId);
}

/** Test helper — wipe all state between cases. */
export function clearAllSidecarTrackers(): void {
  counters.clear();
}
