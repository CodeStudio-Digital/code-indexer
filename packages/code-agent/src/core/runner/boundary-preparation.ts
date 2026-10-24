/** One bounded proactive lookup per run. Late results can only be consumed by
 * a later call at a turn boundary with the same task key. No background promise
 * is allowed to mutate an in-flight provider context. */
export class BoundaryPreparation<T> {
  private pending?: { key: string; ready: Promise<void>; value?: T; settled: boolean };

  async take(
    key: string,
    load: () => Promise<T>,
    signal?: AbortSignal,
    budgetMs = 300,
  ): Promise<T | undefined> {
    if (signal?.aborted) return undefined;
    if (this.pending?.key !== key) {
      // Bound outstanding work to one lookup, even when the user changes task.
      if (this.pending && !this.pending.settled) return undefined;
      this.pending = undefined;
    }
    if (!this.pending) {
      const job = { key, settled: false, ready: Promise.resolve(), value: undefined as T | undefined };
      job.ready = Promise.resolve().then(load).then(
        (value) => { job.value = value; job.settled = true; },
        () => { job.settled = true; },
      );
      this.pending = job;
    }
    const job = this.pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        job.ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budgetMs);
          abort = resolve;
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) resolve();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
    if (signal?.aborted) { this.pending = undefined; return undefined; }
    if (!job.settled) return undefined;
    this.pending = undefined;
    return job.value;
  }
}
