/**
 * Per-session async lock. Serializes the critical section that decides
 * "is there an active run for this sessionId, and if so attach to it"
 * versus "create a new run". Without this, two concurrent POST /messages
 * to the same session could both observe `activeRuns.get(id) === undefined`
 * and each spin up a fresh `runCoder` writing to the same SQLite session.
 *
 * In-process Map of last-promise-per-id. Each acquirer chains onto the
 * previous holder; the final `delete` only fires when the chain is the
 * latest one to avoid leaking a key in the map under contention.
 *
 * NOTE: Single-process only. A multi-process deployment (PM2 cluster, k8s
 * replicas) needs a database-backed lock + heartbeat instead — tracked as
 * Phase 5 of the coder hardening plan.
 */

const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(id) ?? Promise.resolve();
  // Whether `prev` resolved or rejected, we run our `fn` next. The chain
  // never short-circuits on a peer's failure — every acquirer gets a fair turn.
  const next = prev.then(fn, fn);
  // Store a swallowed copy so unhandled rejection from `fn` doesn't poison
  // future acquirers.
  const tail = next.catch(() => { /* swallow */ });
  sessionLocks.set(id, tail);
  try {
    return await next;
  } finally {
    // Only delete if we're still the latest holder — otherwise a faster
    // follow-up acquirer has already taken over the slot.
    if (sessionLocks.get(id) === tail) sessionLocks.delete(id);
  }
}

/** Test/utility hook: clear all locks (used by unit tests between runs). */
export function _resetSessionLocksForTests(): void {
  sessionLocks.clear();
}
