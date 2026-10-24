/** Cancellation must be subscribed before dispatch: an in-process backend may
 * abort synchronously while starting the request. This is best-effort RPC
 * cancellation, not proof that an already dispatched effect was rolled back. */
export function cancellableToolRpc<T>(
  invoke: () => Promise<T>,
  cancel: () => void | Promise<void>,
  signal: AbortSignal | undefined,
  abortMessage: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error(abortMessage));
  if (!signal) return invoke();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Both synchronous and asynchronous cancellation failures are secondary
      // to the original abort. Never leave this request waiting on cleanup.
      try { void Promise.resolve(cancel()).catch(() => undefined); } catch { /* best effort */ }
      reject(new Error(abortMessage));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (value: T) => {
      if (settled) return;
      settled = true; cleanup(); resolve(value);
    };
    const failed = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    try { void invoke().then(done, failed); } catch (error) { failed(error); }
  });
}
