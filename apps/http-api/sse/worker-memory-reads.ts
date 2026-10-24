import { abortableRead } from '../../../packages/shared/src/utils/abortable.js';

/** Per-worker authority for explicit reads. Keep occupied slots until the
 * underlying operation settles, even when a non-cancellable adapter is late. */
export class WorkerMemoryReads {
  private readonly active = new Map<string, AbortController>();
  private closed = false;

  run<T>(readId: unknown, read: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Memory read bridge closed'));
    if (readId === undefined) return read(); // compatibility with older workers
    if (typeof readId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(readId)
      || this.active.has(readId) || this.active.size >= 32) {
      return Promise.reject(new Error('Invalid or saturated memory read request'));
    }
    const ctrl = new AbortController();
    this.active.set(readId, ctrl);
    const timeout = setTimeout(() => ctrl.abort(new DOMException('Memory read timed out', 'TimeoutError')), 15_000);
    timeout.unref();
    const work = Promise.resolve().then(() => { ctrl.signal.throwIfAborted(); return read(ctrl.signal); });
    const settled = work.finally(() => { clearTimeout(timeout); this.active.delete(readId); });
    void settled.catch(() => undefined); // cancellation can precede the await subscription
    return abortableRead(() => settled, ctrl.signal);
  }

  cancel(readId: unknown): void {
    if (typeof readId === 'string') this.active.get(readId)?.abort(new DOMException('Memory read cancelled', 'AbortError'));
  }

  close(): void {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort(new DOMException('Memory bridge closed', 'AbortError'));
  }
}
