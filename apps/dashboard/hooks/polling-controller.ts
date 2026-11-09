/** Coarse status polling: hidden windows own no timer and slow requests never overlap. */
export function startPolling(
  callback: () => void | Promise<void>,
  intervalMs: number | (() => number),
  immediate: boolean,
  visibility: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
): () => void {
  let disposed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => visibility.visibilityState !== 'hidden';
  const stopTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (!disposed && visible() && !running && timer === undefined) {
      const delay = typeof intervalMs === 'function' ? intervalMs() : intervalMs;
      timer = setTimeout(() => { timer = undefined; void tick(); }, Math.max(1, delay));
    }
  };
  const tick = async () => {
    if (disposed || !visible() || running) return;
    running = true;
    try {
      await callback();
    } catch (error) {
      // Callers normally surface their own fetch error. A rejected callback
      // must not terminate all future polling or become an unhandled rejection.
      console.warn('[polling] status refresh failed', error);
    } finally {
      running = false;
      schedule();
    }
  };
  const onVisibility = () => {
    stopTimer();
    if (!visible() || disposed) return;
    if (immediate) void tick();
    else schedule();
  };
  visibility.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  return () => {
    disposed = true;
    stopTimer();
    visibility.removeEventListener('visibilitychange', onVisibility);
  };
}
