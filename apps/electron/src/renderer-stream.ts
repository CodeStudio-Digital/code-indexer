interface StreamFrame<T> {
  type: 'value' | 'error' | 'done';
  value?: T;
  error?: { message: string; code?: string; status?: number };
}

/** The preload owns the transferred port; consumers own only this iterator. */
export function createRendererStream<T>(
  connect: (accept: (port: MessagePort) => void) => () => void,
  cancel: () => void = () => {},
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  const waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
  let port: MessagePort | undefined;
  let ended = false;
  let error: Error | undefined;
  let disconnect: (() => void) | undefined;
  let cancelled = false;
  const cancelSubscription = () => {
    if (cancelled) return;
    cancelled = true;
    try { cancel(); } catch { /* renderer/main already shutting down */ }
  };
  // A main-process failure must not strand the transfer listener forever.
  // On early return it remains only until the already-requested port arrives,
  // so even a late transferred port is explicitly closed.
  let transferTimer: ReturnType<typeof setTimeout> | undefined;
  const done = (): IteratorResult<T> => ({ value: undefined, done: true });
  const closePort = () => {
    if (!port) return;
    port.onmessage = null;
    port.onmessageerror = null;
    port.close();
    port = undefined;
  };
  const finish = (failure?: Error, discard = false) => {
    ended = true;
    error = failure;
    if (discard || failure) queue.length = 0;
    for (const waiter of waiters.splice(0)) {
      if (failure) waiter.reject(failure);
      else waiter.resolve(done());
    }
    closePort();
  };
  transferTimer = setTimeout(() => {
    disconnect?.();
    disconnect = undefined;
    if (!ended) {
      cancelSubscription();
      finish(new Error('stream port transfer timed out'), true);
    }
  }, 15_000);
  const accept = (received: MessagePort) => {
    clearTimeout(transferTimer);
    transferTimer = undefined;
    disconnect?.();
    disconnect = undefined;
    if (ended) {
      received.close();
      return;
    }
    port = received;
    received.onmessage = ({ data }: MessageEvent<StreamFrame<T>>) => {
      if (ended) return;
      if (data.type === 'value') {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve({ value: data.value!, done: false });
        else queue.push(data.value!);
      } else if (data.type === 'error') {
        finish(Object.assign(new Error(data.error?.message ?? 'stream error'), data.error), true);
      } else if (data.type === 'done') {
        finish();
      }
    };
    received.onmessageerror = () => finish(new Error('stream message could not be decoded'), true);
    received.start();
  };
  try {
    disconnect = connect(accept);
  } catch (error) {
    clearTimeout(transferTimer);
    throw error;
  }
  // connect is allowed to deliver synchronously (also useful for adapters).
  if (port || transferTimer === undefined) { disconnect?.(); disconnect = undefined; }

  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (queue.length > 0) return { value: queue.shift()!, done: false };
      if (error) throw error;
      if (ended) return done();
      return new Promise<IteratorResult<T>>((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
    async return() {
      // Returning is an explicit unsubscribe, including already-buffered data.
      if (!ended) cancelSubscription();
      finish(undefined, true);
      return done();
    },
  };
}
