type Access = 'read_only' | 'exclusive_write';
type Waiter = { access: Access; signal: AbortSignal; abort(): void; resolve(release: () => void): void; reject(cause: unknown): void };

/** FIFO admission for siblings. Writes are barriers; only adjacent read-only
 * children overlap. Physical process accounting remains a separate hard gate. */
export class NativeTreeScheduler {
  private readonly queue: Waiter[] = [];
  private active = 0;
  private writer = false;
  private closed = false;
  constructor(private readonly parallel: number) {
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('Invalid native tree scheduler capacity');
  }
  acquire(access: Access, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.closed || this.queue.length >= 255) return Promise.reject(new Error('Native tree scheduler is closed or full'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { access, signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort); reject(signal.reason); this.pump();
      } };
      this.queue.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true }); this.pump();
    });
  }
  close() {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort); waiter.reject(new Error('Native tree owner closed before child admission'));
    }
  }
  private pump() {
    while (!this.closed && !this.writer && this.active < this.parallel && this.queue.length) {
      const waiter = this.queue[0]!;
      if (waiter.access === 'exclusive_write' && this.active) return;
      this.queue.shift(); waiter.signal.removeEventListener('abort', waiter.abort);
      this.active++; this.writer = waiter.access === 'exclusive_write';
      let released = false;
      waiter.resolve(() => {
        if (released) return; released = true;
        this.active--; if (waiter.access === 'exclusive_write') this.writer = false; this.pump();
      });
    }
  }
}
