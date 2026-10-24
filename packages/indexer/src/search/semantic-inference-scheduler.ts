interface PendingInference<T = unknown> {
  priority: number;
  sequence: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  supersessionKey?: string;
  cleanup?: () => void;
}

export class SupersededInferenceError extends Error {
  readonly code = 'SEMANTIC_INFERENCE_SUPERSEDED';

  constructor(key: string) {
    super(`semantic inference superseded for ${key}`);
    this.name = 'SupersededInferenceError';
  }
}

/** Cooperative one-session-at-a-time scheduler shared by embedding and
 * reranking inside the semantic worker. Interactive queries do not interrupt
 * native inference mid-batch; they take the very next slot before backfill. */
export class SemanticInferenceScheduler {
  private pending: PendingInference[] = [];
  private active = false;
  private sequence = 0;
  private stopped: Error | null = null;

  constructor(private readonly maxPending = 128) {}

  enqueue<T>(
    priority: number,
    run: () => Promise<T>,
    options: { supersessionKey?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped);
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Inference aborted'));
    return new Promise<T>((resolve, reject) => {
      if (options.supersessionKey) {
        const retained: PendingInference[] = [];
        for (const entry of this.pending) {
          if (entry.supersessionKey === options.supersessionKey) {
            entry.cleanup?.();
            entry.reject(new SupersededInferenceError(options.supersessionKey));
          } else {
            retained.push(entry);
          }
        }
        this.pending = retained;
      }
      if (this.pending.length >= this.maxPending) {
        reject(new Error('Semantic inference queue is full; retry after current work completes'));
        return;
      }
      const entry: PendingInference = {
        priority,
        sequence: this.sequence++,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        supersessionKey: options.supersessionKey,
      };
      if (options.signal) {
        const abort = () => {
          const index = this.pending.indexOf(entry);
          if (index < 0) return; // Native inference already running: caller discards its result.
          this.pending.splice(index, 1);
          entry.cleanup?.();
          reject(options.signal!.reason ?? new Error('Inference aborted'));
        };
        entry.cleanup = () => options.signal!.removeEventListener('abort', abort);
        options.signal.addEventListener('abort', abort, { once: true });
      }
      this.pending.push(entry);
      this.pending.sort((left, right) =>
        right.priority - left.priority || left.sequence - right.sequence);
      void this.drain();
    });
  }

  close(reason = new Error('semantic inference scheduler stopped')): void {
    this.stopped = reason;
    for (const entry of this.pending.splice(0)) { entry.cleanup?.(); entry.reject(reason); }
  }

  diagnostics(): { active: boolean; queued: number } {
    return { active: this.active, queued: this.pending.length };
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (!this.stopped && this.pending.length > 0) {
        const entry = this.pending.shift()!;
        entry.cleanup?.();
        try { entry.resolve(await entry.run()); }
        catch (error) { entry.reject(error); }
      }
    } finally {
      this.active = false;
      if (!this.stopped && this.pending.length > 0) void this.drain();
    }
  }
}
