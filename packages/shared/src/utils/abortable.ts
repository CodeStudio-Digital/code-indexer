/** Stop awaiting read-only work on cancellation. Providers should also consume
 * the signal; a provider that cannot interrupt must have its late result ignored. */
export function abortableRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    void Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}
