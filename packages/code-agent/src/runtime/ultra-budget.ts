export class UltraAgentBudget {
  private active = 0;
  private used = 0;
  private waiters = new Set<() => void>();
  constructor(readonly maxParallel: number, readonly maxAgents: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.used >= this.maxAgents || this.maxParallel < 1) throw new Error('Ultra agent budget reached; finish with existing agents instead of spawning more');
      if (this.active < this.maxParallel) break;
      await new Promise<void>(resolve => {
        const done = () => { this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
        this.waiters.add(done); signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
    this.active++; this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.active--;
      for (const wake of [...this.waiters]) wake();
    };
  }
}
