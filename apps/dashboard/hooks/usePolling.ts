import { useEffect, useRef } from 'react';
import { startPolling } from './polling-controller.js';
import { useSurfaceVisible } from '../lib/surface-visibility.js';

interface PollingOptions {
  /** When false the timer is off (e.g. only poll while an execution is live). */
  enabled?: boolean;
  /** Fire the callback once immediately when the timer (re)starts. Default true. */
  immediate?: boolean;
}

/**
 * Visibility-aware polling with a delay after each completed refresh. The raw
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
 *  4. **Overlapping requests** — return the refresh Promise so a slow backend
 *     finishes before another periodic request starts.
 *
 * Does NOT replace SSE/streams — it's the fallback/coarse-status poll only.
 */
export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: PollingOptions = {},
): void {
  const { enabled = true, immediate = true } = options;
  const visible = useSurfaceVisible();
  const cbRef = useRef(callback);
  useEffect(() => { cbRef.current = callback; }, [callback]);

  useEffect(() => {
    if (!enabled || !visible) return;

    return startPolling(() => cbRef.current(), intervalMs, immediate);
  }, [intervalMs, enabled, immediate, visible]);
}
