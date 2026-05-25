/**
 * Promise mutex utilities — keep the serial-promise patterns we use in
 * the company orchestrator (`MasterInboxRouter.routeMutex`,
 * `InboxQueue.drainMutexes`, etc.) from deadlocking the entire session
 * when a participant in the chain never resolves.
 *
 * The chain mechanic itself is fine — it gives us strict FIFO without
 * pulling in a Mutex library — but without a timeout one stuck step
 * blocks every future step on that mutex. We saw exactly this happen on
 * `MasterInboxRouter`: if `claimAllPendingMasterMessages` threw inside a
 * `try`-less branch or `master.notify` hung mid-resurrect, the
 * `routeMutex` chain wedged forever and the dashboard "Mestre em
 * standby" badge stayed there even with pending inbox.
 *
 * `raceWithTimeout` is the building block: it races the original promise
 * against a timer; if the timer wins, it rejects with `mutex_timeout:<label>:<ms>ms`
 * so callers can pattern-match and decide what to do (typically: reset
 * the chain to `Promise.resolve()`, log the recovery, and continue).
 *
 * The timeout cleanup (`clearTimeout` in `finally`) is the critical
 * part — without it, every call would leave an unbounded number of
 * Node timers in the event loop.
 */

export class MutexTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`mutex_timeout:${label}:${timeoutMs}ms`);
    this.name = 'MutexTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Returns whether an error came from this helper. Cheap to check via
 * `error?.name` so callers don't have to import the class everywhere.
 */
export function isMutexTimeout(e: unknown): e is MutexTimeoutError {
  return e instanceof Error && e.name === 'MutexTimeoutError';
}

/**
 * Race `promise` against a timeout. Resolves/rejects with the original
 * promise when it settles first; rejects with `MutexTimeoutError` when
 * the timer wins.
 *
 * The timer is unconditionally cleared in `finally`, even on early
 * settle, so we never leak handles. We rely on `Promise.race` short-
 * circuiting on first settlement — the original promise keeps running
 * in the background after a timeout (we can't cancel it from here);
 * callers should reset their mutex chain so the next operation gets a
 * fresh start regardless of whether the stuck one ever resolves.
 *
 * @param promise The work being mutex-protected.
 * @param timeoutMs Milliseconds before the race rejects.
 * @param label Identifier used in the error message + log line.
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MutexTimeoutError(label, timeoutMs)), timeoutMs);
    // `.unref()` so a pending timeout doesn't keep Node alive when the
    // process is shutting down — matches the pattern used by every
    // other timer in the company package.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
