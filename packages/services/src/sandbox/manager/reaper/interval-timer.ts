/**
 * Tiny wrapper around `setInterval` so reaper + stats sampler share a
 * single start/stop idiom. The handle is `unref`'d so the timer never
 * holds the event loop open beyond active work.
 */
export class IntervalTimer {
  private handle: NodeJS.Timeout | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => void,
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.handle) return;
    this.handle = setInterval(this.tick, this.intervalMs);
    this.handle.unref();
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  isRunning(): boolean {
    return this.handle !== null;
  }
}
