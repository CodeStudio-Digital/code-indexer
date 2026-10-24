/** Attempt-owned input slots used by PermissionGate and interactive Host
 * tools. Registration precedes publication; cancellation settles every waiter. */
export class NativeCoderInteractions {
  private readonly pending = new Map<string, (value: string) => void>();
  private closed = false;
  private readonly cancelledWithoutResponse = new Set<string>();
  private defaultId?: string;
  private readonly abort: () => void;

  constructor(private readonly signal: AbortSignal) {
    this.abort = () => this.close();
    if (signal.aborted) this.close(); else signal.addEventListener('abort', this.abort, { once: true });
  }

  get pendingDefaultId() { return this.defaultId; }
  get isWaiting() { return this.pending.size > 0; }
  hasPending(interactionId: string) { return !this.closed && this.pending.has(interactionId); }
  wasCancelledWithoutResponse(interactionId: string) { return this.cancelledWithoutResponse.has(interactionId); }

  waitForInput(interactionId: string, defaultReview = false): Promise<string> {
    if (this.closed) return Promise.resolve(JSON.stringify({ aborted: true }));
    if (!interactionId || interactionId.length > 1_024 || this.pending.has(interactionId)
      || this.pending.size >= 64) throw new Error('Native interaction slot is duplicate or exceeds the bound');
    if (defaultReview && this.defaultId) throw new Error('Native default interaction is already pending');
    if (defaultReview) this.defaultId = interactionId;
    return new Promise<string>((resolve) => this.pending.set(interactionId, resolve));
  }

  async provideInput(interactionId: string, value: string): Promise<boolean> {
    if (this.closed || Buffer.byteLength(value, 'utf8') > 1024 * 1024) return false;
    const resolve = this.pending.get(interactionId);
    if (!resolve) return false;
    this.pending.delete(interactionId);
    if (this.defaultId === interactionId) this.defaultId = undefined;
    resolve(value); return true;
  }

  close(): void {
    this.closed = true; this.signal.removeEventListener('abort', this.abort);
    for (const [id, resolve] of this.pending) {
      this.cancelledWithoutResponse.add(id);
      resolve(JSON.stringify({ aborted: true }));
    }
    this.pending.clear();
    this.defaultId = undefined;
  }
}
