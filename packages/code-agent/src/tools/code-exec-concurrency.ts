/** FIFO read batches with exclusive barriers. A granted permit belongs to the
 * physical invocation, not its timeout race, and must survive until it settles. */
export class NestedToolConcurrencyGate {
  private active = 0;
  private exclusive = false;
  private revision = 0;
  get epoch() { return this.revision; }
  invalidate() { return ++this.revision; }
  private readonly waiters: Array<{
    parallelRead: boolean; resolve: (release: () => void) => void;
    reject: (reason: unknown) => void; signal?: AbortSignal; abort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid nested read concurrency');
  }

  reserve(parallelRead: boolean, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Nested tool cancelled'));
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { parallelRead, resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.abort!);
          reject(signal.reason ?? new Error('Nested tool cancelled'));
          this.dispatch();
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (!this.exclusive && this.active < this.limit && this.waiters.length) {
      const waiter = this.waiters[0]!;
      if (!waiter.parallelRead && this.active > 0) return;
      this.waiters.shift();
      if (waiter.abort) waiter.signal!.removeEventListener('abort', waiter.abort);
      if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue; }
      this.active++;
      this.exclusive = !waiter.parallelRead;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        if (!waiter.parallelRead) this.exclusive = false;
        this.dispatch();
      });
    }
  }
}

const gates = new WeakMap<object, NestedToolConcurrencyGate>();
/** Multiple code_exec invocations in one runner share its physical barriers. */
export function nestedToolConcurrencyGate(owner: object, limit: number): NestedToolConcurrencyGate {
  let gate = gates.get(owner);
  if (!gate) { gate = new NestedToolConcurrencyGate(limit); gates.set(owner, gate); }
  return gate;
}
