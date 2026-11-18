/** Overlap pure inference with durable writes; never let effects or a terminal commit overtake them. */
export class TurnPersistenceBarrier {
  private readonly startedAt = performance.now();
  private readonly failure = new AbortController();
  private readonly settled: Promise<void>;
  private error: unknown;
  private failed = false;
  durationMs = 0;
  waitMs = 0;

  constructor(flush?: () => void | Promise<void>) {
    // Attach rejection handling immediately, including when assembly exits early.
    this.settled = Promise.resolve().then(() => flush?.()).then(() => {
      this.durationMs = performance.now() - this.startedAt;
    }, (error: unknown) => {
      this.durationMs = performance.now() - this.startedAt;
      this.failed = true;
      this.error = error;
      this.failure.abort(error);
    });
  }

  get failureSignal(): AbortSignal { return this.failure.signal; }

  async wait(): Promise<void> {
    const start = performance.now();
    await this.settled;
    this.waitMs += performance.now() - start;
    if (this.failed) throw this.error;
  }
}
