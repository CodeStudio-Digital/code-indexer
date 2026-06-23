/**
 * Idle-shutdown controller for worker pools: arms an unref'd timer when the
 * pool goes quiescent and runs `teardown()` when it fires. A generation
 * counter invalidates schedules that were outrun by new work (the timer
 * callback may already be queued when a dispatch lands — clearTimeout alone
 * cannot cover that race).
 */
export interface IdleShutdownController {
  /** New work arrived — cancel any armed timer and invalidate stale schedules. */
  touch(): void;
  /** Pool may have gone quiescent — arm the timer if so. */
  maybeArm(): void;
  /** Permanent stop (pool close). */
  stop(): void;
}

export function createIdleShutdown(opts: {
  idleTtlMs: number;
  label: string;
  /** True when there is no outstanding work and the pool is still healthy. */
  isQuiescent(): boolean;
  hasWorkers(): boolean;
  /** Terminate the workers; returns how many were torn down. */
  teardown(): number;
}): IdleShutdownController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let stopped = false;

  const clear = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  return {
    touch(): void {
      generation++;
      clear();
    },
    maybeArm(): void {
      if (stopped || opts.idleTtlMs <= 0) return;
      if (!opts.isQuiescent() || !opts.hasWorkers()) return;
      clear();
      const gen = generation;
      timer = setTimeout(() => {
        timer = null;
        if (stopped || gen !== generation || !opts.isQuiescent()) return;
        const n = opts.teardown();
        if (n > 0) console.error(`[pool${opts.label}] idle shutdown — terminated ${n} worker(s)`);
      }, opts.idleTtlMs);
      timer.unref?.();
    },
    stop(): void {
      stopped = true;
      generation++;
      clear();
    },
  };
}
