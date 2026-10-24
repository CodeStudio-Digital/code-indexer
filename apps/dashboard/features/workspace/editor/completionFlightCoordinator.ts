export interface ClientCompletionSnapshot {
  uri: string;
  prefix: string;
  suffix: string;
  line: number;
  col: number;
  documentVersion: number;
  trigger: 'automatic' | 'explicit';
}

interface Flight<T> {
  key: string;
  anchor: ClientCompletionSnapshot;
  clientRequestId: string;
  promise: Promise<T>;
  waiters: Set<symbol>;
  settled: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  cancel: (clientRequestId: string) => void;
}

interface ClientCompletionLease<T> {
  clientRequestId: string;
  promise: Promise<T>;
  typedThrough: string;
  owner: boolean;
  release(cancelled?: boolean): void;
}

export function compatibleCompletionSnapshot(
  anchor: ClientCompletionSnapshot,
  next: ClientCompletionSnapshot,
): { compatible: boolean; typedThrough: string } {
  if (anchor.uri !== next.uri || anchor.suffix !== next.suffix || anchor.line !== next.line
    || anchor.trigger !== next.trigger || next.col < anchor.col || !next.prefix.startsWith(anchor.prefix)) {
    return { compatible: false, typedThrough: '' };
  }
  const typedThrough = next.prefix.slice(anchor.prefix.length);
  if (typedThrough.includes('\n') || next.col - anchor.col !== typedThrough.length) {
    return { compatible: false, typedThrough: '' };
  }
  return { compatible: true, typedThrough };
}

export function adaptCompletionText(
  text: string,
  typedThrough: string,
): { text: string } | { reason: 'prefix_diverged' | 'empty_after_trim' } {
  if (!text.startsWith(typedThrough)) return { reason: 'prefix_diverged' };
  const adapted = text.slice(typedThrough.length);
  return adapted ? { text: adapted } : { reason: 'empty_after_trim' };
}

/** Browser-side latest-wins coordinator. It deliberately outlives individual
 * Monaco cancellation tokens, because Monaco cancels on every content change. */
export class ClientCompletionFlightCoordinator<T> {
  private readonly flights = new Map<string, Flight<T>>();

  acquire(opts: {
    key: string;
    snapshot: ClientCompletionSnapshot;
    start: (clientRequestId: string) => Promise<T>;
    cancel: (clientRequestId: string) => void;
    cancelDelayMs: number;
    cacheTtlMs?: number;
    createId?: () => string;
    onOrphaned?: (value: T, flight: { key: string; clientRequestId: string; anchor: ClientCompletionSnapshot }) => void;
  }): ClientCompletionLease<T> {
    const current = this.flights.get(opts.key);
    const match = current ? compatibleCompletionSnapshot(current.anchor, opts.snapshot) : null;
    let flight: Flight<T>;
    let owner = false;
    let typedThrough = match?.typedThrough ?? '';

    if (current && match?.compatible) {
      flight = current;
      if (flight.cancelTimer) { clearTimeout(flight.cancelTimer); flight.cancelTimer = undefined; }
    } else {
      if (current) this.abortFlight(current);
      owner = true;
      const clientRequestId = opts.createId?.() ?? crypto.randomUUID();
      flight = {
        key: opts.key, anchor: opts.snapshot, clientRequestId,
        promise: Promise.resolve(undefined as T), waiters: new Set(), settled: false,
        cancel: opts.cancel,
      };
      flight.promise = opts.start(clientRequestId);
      this.flights.set(opts.key, flight);
      void flight.promise.then((value) => {
        flight.settled = true;
        if (this.flights.get(opts.key) !== flight) return;
        if (flight.waiters.size === 0) {
          opts.onOrphaned?.(value, { key: flight.key, clientRequestId, anchor: flight.anchor });
        }
        flight.expiryTimer = setTimeout(() => {
          if (this.flights.get(opts.key) === flight) this.flights.delete(opts.key);
        }, opts.cacheTtlMs ?? 1_000);
      }, () => {
        flight.settled = true;
        if (this.flights.get(opts.key) === flight) this.flights.delete(opts.key);
      });
    }

    const waiter = Symbol('completion-waiter');
    flight.waiters.add(waiter);
    let released = false;
    return {
      clientRequestId: flight.clientRequestId,
      promise: flight.promise,
      typedThrough,
      owner,
      release: (cancelled = false) => {
        if (released) return;
        released = true;
        flight.waiters.delete(waiter);
        if (!cancelled || flight.settled || flight.waiters.size > 0 || this.flights.get(opts.key) !== flight) return;
        flight.cancelTimer = setTimeout(() => {
          flight.cancelTimer = undefined;
          if (!flight.settled && flight.waiters.size === 0 && this.flights.get(opts.key) === flight) this.abortFlight(flight);
        }, opts.cancelDelayMs);
      },
    };
  }

  hasWaiters(key: string): boolean {
    return (this.flights.get(key)?.waiters.size ?? 0) > 0;
  }

  invalidate(key: string): void {
    const flight = this.flights.get(key);
    if (flight) this.abortFlight(flight);
  }

  clear(): void {
    for (const flight of this.flights.values()) this.abortFlight(flight);
    this.flights.clear();
  }

  private abortFlight(flight: Flight<T>): void {
    if (flight.cancelTimer) clearTimeout(flight.cancelTimer);
    if (flight.expiryTimer) clearTimeout(flight.expiryTimer);
    if (!flight.settled) flight.cancel(flight.clientRequestId);
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
  }
}

