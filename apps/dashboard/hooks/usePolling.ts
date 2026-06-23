import { useEffect, useRef } from 'react';

interface PollingOptions {
  /** When false the timer is off (e.g. only poll while an execution is live). */
  enabled?: boolean;
  /** Fire the callback once immediately when the timer (re)starts. Default true. */
  immediate?: boolean;
}

/**
 * Visibility-aware `setInterval` for status polling. Three things the raw
 * `setInterval` pattern scattered across panels got wrong:
 *
 *  1. **Hidden tab/window keeps polling** — backgrounded Electron windows
 *     hammered the backend every few seconds for nothing. We pause while
 *     `document.visibilityState === 'hidden'` and resume on focus.
 *  2. **Interval churn** — effects that listed the callback (often an
 *     unstable `refetch`) in their deps tore down and recreated the timer
 *     on every render. We hold the callback in a ref so the timer is
 *     created once per `[intervalMs, enabled]`.
 *  3. **Polling while idle** — callers pass `enabled` to stop the timer
 *     when there's nothing live to watch.
 *
 * Does NOT replace SSE/streams — it's the fallback/coarse-status poll only.
 */
export function usePolling(
  callback: () => void,
  intervalMs: number,
  options: PollingOptions = {},
): void {
  const { enabled = true, immediate = true } = options;
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState !== 'hidden') cbRef.current();
    };
    const start = () => {
      if (id == null) id = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };

    if (immediate) cbRef.current();
    start();

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled, immediate]);
}
