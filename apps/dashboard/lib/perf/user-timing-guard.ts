/**
 * Defensive bound on the User Timing buffer (`performance` measures/marks).
 *
 * The app itself never calls `performance.measure()` / `performance.mark()` —
 * the only producers are:
 *   (a) React's DEV scheduling profiler, active only when React DevTools is
 *       attached. Those entries feed the DevTools Timeline, so clearing them
 *       would wipe an in-progress profiling recording — we must NOT touch them.
 *   (b) Any future instrumentation we add, plus stray third-party entries.
 *       These are safe to drop once the buffer grows large.
 *
 * Strategy: skip entirely when React DevTools is present (protect case a), and
 * otherwise clear measures/marks once they cross a high-water mark (bound case
 * b). In a production build React emits none of these, so this is a near-no-op
 * safety net against unbounded growth in very long-lived sessions.
 */

const HIGH_WATER = 4_000;

function devtoolsPresent(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
        .__REACT_DEVTOOLS_GLOBAL_HOOK__,
    )
  );
}

export function boundUserTimingBuffer(highWater = HIGH_WATER): void {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return;
  }
  if (devtoolsPresent()) {
    return; // never fight the React DevTools Timeline profiler
  }
  try {
    const count =
      performance.getEntriesByType('measure').length +
      performance.getEntriesByType('mark').length;
    if (count < highWater) {
      return;
    }
    performance.clearMeasures?.();
    performance.clearMarks?.();
  } catch {
    // best-effort; never affect the app.
  }
}

let guardTimer: ReturnType<typeof setInterval> | undefined;

export function startUserTimingBufferGuard(intervalMs = 60_000): void {
  if (guardTimer !== undefined || typeof window === 'undefined') {
    return;
  }
  guardTimer = setInterval(() => boundUserTimingBuffer(), intervalMs);
}

export function stopUserTimingBufferGuard(): void {
  if (guardTimer !== undefined) {
    clearInterval(guardTimer);
    guardTimer = undefined;
  }
}
