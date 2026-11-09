/**
 * Race-helpers for the Executing/Compacting nodes — Frente A (PR 1).
 *
 * The BT was previously vulnerable to two classes of hang:
 *   1. `await provider.chat()` / `compactWithLLM()` that never resolved
 *      because the underlying provider stalled past every internal
 *      timeout AND the user's abort signal was ignored.
 *   2. `registry.invoke(toolName, ...)` for a misbehaving MCP tool with no
 *      `timeoutMs` declared — the Camada 1 heartbeat surfaced "still
 *      running" but couldn't cancel the call.
 *
 * Both fixed here:
 *   - `withAbort` races a promise against an AbortSignal, cleans the
 *     listener up so it never leaks even on the happy path.
 *   - `withTimeout` adds a hard deadline; cleans the timer up.
 *   - `withAbortAndTimeout` composes both — useful for tool dispatch.
 *
 * Pure: no shared state, no I/O. Throws `AbortError` / `TimeoutError`
 * with `.code` set so callers can distinguish them from upstream errors.
 */

export class AbortError extends Error {
  readonly code = 'ABORTED';
  constructor(message = 'aborted by signal') {
    super(message);
    this.name = 'AbortError';
  }
}

export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  readonly ms: number;
  constructor(ms: number, label = 'operation') {
    super(`${label} exceeded ${ms}ms`);
    this.name = 'TimeoutError';
    this.ms = ms;
  }
}

/**
 * Race `promise` against `signal`. Returns the promise's value when it
 * resolves first; throws `AbortError` when the signal fires first. The
 * abort listener is removed in `finally` so passing the same signal to
 * many `withAbort` calls in sequence does NOT leak.
 */
export async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The operation was created by the caller before entering this helper.
    // Observe its eventual rejection even when cancellation already won.
    void promise.catch(() => undefined);
    throw new AbortError();
  }
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = (): void => reject(new AbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject);
    });
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Race `promise` against a `ms` deadline. Throws `TimeoutError` if the
 * deadline is reached first. Timer is cleared in `finally` so resolved
 * promises don't leave dangling timeouts in the event loop.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Compose `withAbort` + `withTimeout`. Throws whichever fires first.
 * `ms <= 0` disables the timeout component (only abort applies).
 */
export async function withAbortAndTimeout<T>(
  promise: Promise<T>,
  args: { signal?: AbortSignal; ms?: number; label?: string },
): Promise<T> {
  let wrapped = promise;
  if (args.ms && args.ms > 0) wrapped = withTimeout(wrapped, args.ms, args.label ?? 'operation');
  return withAbort(wrapped, args.signal);
}

/** True when an unknown caught error came from `withAbort`. */
export function isAbortError(e: unknown): e is AbortError {
  return e instanceof Error && (e as { code?: string }).code === 'ABORTED';
}

/** True when an unknown caught error came from `withTimeout`. */
export function isTimeoutError(e: unknown): e is TimeoutError {
  return e instanceof Error && (e as { code?: string }).code === 'TIMEOUT';
}
