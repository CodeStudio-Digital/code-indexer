export type LspRequestPriority = 'background' | 'manual' | 'interactive';

export interface LspRequestSchedulerStats {
  queued: number;
  inFlight: number;
  backgroundInFlight: number;
  cancelled: number;
  superseded: number;
}

interface ScheduledRequest<T = unknown> {
  id: number;
  priority: LspRequestPriority;
  key?: string;
  controller: AbortController;
  externalSignal?: AbortSignal;
  onExternalAbort?: () => void;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  started: boolean;
}

const PRIORITY: Record<LspRequestPriority, number> = {
  background: 0,
  manual: 1,
  interactive: 2,
};

function cancelledError(message = 'LSP request cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Per-server admission control. OmniSharp/JDT LS can accept many JSON-RPC
 * requests, but flooding them while a workspace is loading makes every call
 * slower. Keep two total slots, only one background slot, and let explicit
 * work evict obsolete background work.
 */
export class LspRequestScheduler {
  private nextId = 1;
  private queue: ScheduledRequest[] = [];
  private running = new Map<number, ScheduledRequest>();
  private cancelled = 0;
  private superseded = 0;
  private disposed = false;

  schedule<T>(options: {
    priority: LspRequestPriority;
    key?: string;
    signal?: AbortSignal;
    run: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    if (this.disposed) return Promise.reject(cancelledError('LSP scheduler disposed'));
    if (options.signal?.aborted) return Promise.reject(cancelledError());

    if (options.key) this.supersede(options.key);
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const item: ScheduledRequest<T> = {
        id: this.nextId++,
        priority: options.priority,
        key: options.key,
        controller,
        externalSignal: options.signal,
        run: options.run,
        resolve,
        reject,
        started: false,
      };
      if (options.signal) {
        item.onExternalAbort = () => this.cancel(item, cancelledError());
        options.signal.addEventListener('abort', item.onExternalAbort, { once: true });
      }
      this.queue.push(item as ScheduledRequest);
      this.queue.sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority] || a.id - b.id);
      this.preemptBackgroundFor(item.priority);
      this.pump();
    });
  }

  stats(): LspRequestSchedulerStats {
    return {
      queued: this.queue.length,
      inFlight: this.running.size,
      backgroundInFlight: [...this.running.values()].filter((item) => item.priority === 'background').length,
      cancelled: this.cancelled,
      superseded: this.superseded,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of [...this.queue, ...this.running.values()]) {
      this.cancel(item, cancelledError('LSP scheduler disposed'));
    }
  }

  private supersede(key: string): void {
    for (const item of [...this.queue, ...this.running.values()]) {
      if (item.key !== key) continue;
      this.superseded++;
      this.cancel(item, cancelledError('LSP request superseded'), false);
    }
  }

  private preemptBackgroundFor(priority: LspRequestPriority): void {
    if (priority === 'background' || this.running.size < 2) return;
    const background = [...this.running.values()].find((item) => item.priority === 'background');
    if (background) this.cancel(background, cancelledError('LSP background request preempted'));
  }

  private cancel<T>(item: ScheduledRequest<T>, error: Error, count = true): void {
    if (item.controller.signal.aborted) return;
    if (count) this.cancelled++;
    item.controller.abort(error);
    this.detachExternal(item);
    if (!item.started) {
      this.queue = this.queue.filter((candidate) => candidate.id !== item.id);
      item.reject(error);
      this.pump();
    }
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.running.size < 2) {
      const index = this.queue.findIndex((item) => item.priority !== 'background'
        || ![...this.running.values()].some((running) => running.priority === 'background'));
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      item.started = true;
      this.running.set(item.id, item);
      void item.run(item.controller.signal)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running.delete(item.id);
          this.detachExternal(item);
          this.pump();
        });
    }
  }

  private detachExternal<T>(item: ScheduledRequest<T>): void {
    if (item.externalSignal && item.onExternalAbort) {
      item.externalSignal.removeEventListener('abort', item.onExternalAbort);
      item.onExternalAbort = undefined;
    }
  }
}
