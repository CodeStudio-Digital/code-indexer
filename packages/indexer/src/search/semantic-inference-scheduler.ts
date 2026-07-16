interface PendingInference<T = unknown> {
  priority: number;
  sequence: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  supersessionKey?: string;
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

  enqueue<T>(
    priority: number,
    run: () => Promise<T>,
    options: { supersessionKey?: string } = {},
  ): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped);
    return new Promise<T>((resolve, reject) => {
      if (options.supersessionKey) {
        const retained: PendingInference[] = [];
        for (const entry of this.pending) {
          if (entry.supersessionKey === options.supersessionKey) {
            entry.reject(new SupersededInferenceError(options.supersessionKey));
          } else {
            retained.push(entry);
          }
        }
        this.pending = retained;
      }
      this.pending.push({
        priority,
        sequence: this.sequence++,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        supersessionKey: options.supersessionKey,
      });
      this.pending.sort((left, right) =>
        right.priority - left.priority || left.sequence - right.sequence);
      void this.drain();
    });
  }

  close(reason = new Error('semantic inference scheduler stopped')): void {
    this.stopped = reason;
    for (const entry of this.pending.splice(0)) entry.reject(reason);
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
        try { entry.resolve(await entry.run()); }
        catch (error) { entry.reject(error); }
      }
    } finally {
      this.active = false;
      if (!this.stopped && this.pending.length > 0) void this.drain();
    }
  }
}
