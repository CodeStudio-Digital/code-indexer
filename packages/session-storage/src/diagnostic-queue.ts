/** Best-effort derived records. At most one write can enter the owner queue;
 * producers never wait for disk and lifecycle close explicitly drains it. */
export class DiagnosticQueue {
  private readonly pending = new Map<string, () => Promise<unknown>>();
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  dropped = 0;

  constructor(private readonly onError: (error: unknown) => void, private readonly limit = 128) {}

  enqueue(key: string, write: () => Promise<unknown>): boolean {
    if (this.closed || (!this.pending.has(key) && this.pending.size >= this.limit)) {
      this.dropped++;
      return false;
    }
    this.pending.set(key, write);
    if (!this.timer && !this.active) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 50);
      this.timer.unref();
    }
    return true;
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.active) return this.active;
    this.active = (async () => {
      while (this.pending.size) {
        const [key, write] = this.pending.entries().next().value!;
        this.pending.delete(key);
        try { await write(); } catch (error) { try { this.onError(error); } catch { /* diagnostic observer */ } }
        // Give incoming transcript/control-plane work a chance to enqueue.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })();
    try { await this.active; } finally {
      this.active = null;
      if (this.pending.size) await this.flush();
    }
  }

  async close(): Promise<void> { this.closed = true; await this.flush(); }
}
