import { AsyncLocalStorage } from 'node:async_hooks';

const currentEffects = new AsyncLocalStorage<ReadonlySet<Promise<unknown>>>();

/** Tracks the real Host invocation lifetime, including handlers that ignore
 * cancellation. Transport cancellation never proves those effects have ended. */
export class HostEffectScope {
  private readonly pending = new Set<Promise<unknown>>();
  private sealed = false;

  get activeCount(): number { return this.pending.size; }

  track<T>(start: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new Error('Host effect scope is closed'));
    // Reserve ownership before invoking user/tool code, including synchronous throws.
    const ancestors = currentEffects.getStore();
    const task: Promise<T> = Promise.resolve().then(() => {
      const owned = new Set(ancestors); owned.add(task);
      return currentEffects.run(owned, start);
    });
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  seal(): void { this.sealed = true; }

  /** The workspace owner must synchronously fence new mutations first. A
   * spawn invocation excludes itself and its enclosing calls, so draining
   * older effects cannot wait on the child it is about to launch. */
  async waitForOtherEffects(signal?: AbortSignal): Promise<void> {
    const owned = currentEffects.getStore();
    return settle([...this.pending].filter(task => !owned?.has(task)), signal);
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    this.seal();
    return settle([...this.pending], signal);
  }
}

async function settle(pending: readonly Promise<unknown>[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const settled = Promise.allSettled(pending).then(() => undefined);
  if (!signal) return settled;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Host effects have not settled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([settled, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
