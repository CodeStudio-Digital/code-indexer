/**
 * Bounded, strictly ordered async writer.
 *
 * SSE and WebSocket subscribers are intentionally decoupled from the run:
 * disconnecting one slow consumer must never stop the bus. The bus replay
 * ring remains the recovery source and the reconnecting client resumes from
 * its last acknowledged sequence.
 */

const DEFAULT_STREAM_MAX_PENDING_WRITES = 2_048;
/**
 * The replay bus retains at most 8 MiB before JSON encoding. Escaping control
 * characters can expand a valid retained string by up to 6x on the wire, so
 * the subscriber bound must accommodate one full healthy replay.
 */
const DEFAULT_STREAM_MAX_PENDING_BYTES = 52 * 1024 * 1024;
const DEFAULT_STREAM_DRAIN_TIMEOUT_MS = 5_000;

interface SerializedWriteQueueOptions {
  maxPendingWrites?: number;
  maxPendingBytes?: number;
  signal?: AbortSignal;
  onOverflow?: (error: SlowConsumerError) => void;
  onWriteError?: (error: unknown) => void;
}

export class SlowConsumerError extends Error {
  readonly code = 'SLOW_CONSUMER';

  constructor(
    readonly pendingWrites: number,
    readonly pendingBytes: number,
    readonly incomingBytes: number,
  ) {
    super(
      `stream consumer backlog exceeded `
      + `(${pendingWrites} writes, ${pendingBytes} bytes, incoming ${incomingBytes} bytes)`,
    );
    this.name = 'SlowConsumerError';
  }
}

interface QueuedWrite<T> {
  value: T;
  bytes: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * A single queue instance belongs to one transport subscriber. It bounds
 * outstanding work (the active write plus queued writes), preserves order,
 * and stops accepting work after an overflow or transport error.
 */
export class SerializedWriteQueue<T> {
  private readonly maxPendingWrites: number;
  private readonly maxPendingBytes: number;
  private readonly signal?: AbortSignal;
  private readonly onOverflow?: (error: SlowConsumerError) => void;
  private readonly onWriteError?: (error: unknown) => void;
  private queue: Array<QueuedWrite<T>> = [];
  private active: QueuedWrite<T> | null = null;
  private readonly idleWaiters = new Set<() => void>();
  private stopped = false;
  private stopReason: unknown = new Error('stream writer stopped');
  private _pendingWrites = 0;
  private _pendingBytes = 0;

  constructor(
    private readonly write: (value: T) => Promise<unknown>,
    opts: SerializedWriteQueueOptions = {},
  ) {
    this.maxPendingWrites = positiveLimit(
      opts.maxPendingWrites,
      DEFAULT_STREAM_MAX_PENDING_WRITES,
    );
    this.maxPendingBytes = positiveLimit(
      opts.maxPendingBytes,
      DEFAULT_STREAM_MAX_PENDING_BYTES,
    );
    this.signal = opts.signal;
    this.onOverflow = opts.onOverflow;
    this.onWriteError = opts.onWriteError;
  }

  get pendingWrites(): number {
    return this._pendingWrites;
  }

  get pendingBytes(): number {
    return this._pendingBytes;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  enqueue(value: T, estimatedBytes: number): Promise<void> {
    const bytes = normalizedBytes(estimatedBytes);
    if (this.stopped) return Promise.reject(this.stopReason);
    if (this.signal?.aborted) {
      const error = abortError();
      this.stop(error);
      return Promise.reject(error);
    }

    // This is an absolute subscriber bound, not only a backlog bound. A single
    // live row can exceed the replay bus cap and therefore cannot be recovered
    // on reconnect; retaining it here would permit an unbounded allocation.
    const countOverflow = this._pendingWrites >= this.maxPendingWrites;
    const byteOverflow = this._pendingBytes + bytes > this.maxPendingBytes;
    if (countOverflow || byteOverflow) {
      const error = new SlowConsumerError(
        this._pendingWrites,
        this._pendingBytes,
        bytes,
      );
      this.stop(error);
      try { this.onOverflow?.(error); } catch { /* diagnostics are best-effort */ }
      return Promise.reject(error);
    }

    this._pendingWrites += 1;
    this._pendingBytes += bytes;

    const pending = new Promise<void>((resolve, reject) => {
      this.queue.push({ value, bytes, resolve, reject });
    });
    this.pump();
    return pending;
  }

  private pump(): void {
    if (this.active || this.stopped) return;
    const item = this.queue.shift();
    if (!item) {
      this.notifyIdle();
      return;
    }
    this.active = item;

    let writeResult: Promise<unknown>;
    try {
      writeResult = Promise.resolve(this.write(item.value));
    } catch (error) {
      writeResult = Promise.reject(error);
    }
    void writeResult.then(
      () => this.finishActive(item, true),
      (error) => this.finishActive(item, false, error),
    );
  }

  private finishActive(item: QueuedWrite<T>, succeeded: boolean, error?: unknown): void {
    if (this.active !== item) return;
    this.active = null;
    this._pendingWrites = Math.max(0, this._pendingWrites - 1);
    this._pendingBytes = Math.max(0, this._pendingBytes - item.bytes);

    if (!succeeded) {
      item.reject(error);
      this.stop(error);
      try { this.onWriteError?.(error); } catch { /* diagnostics are best-effort */ }
    } else {
      item.resolve();
    }

    if (this.stopped) this.notifyIdle();
    else this.pump();
  }

  stop(reason: unknown = new Error('stream writer stopped')): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    // A promise chain retains every captured payload behind a hung active
    // write. This explicit queue can reject and drop all not-yet-started
    // values immediately; only the one value already owned by the transport
    // remains until that transport settles.
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) {
      this._pendingWrites = Math.max(0, this._pendingWrites - 1);
      this._pendingBytes = Math.max(0, this._pendingBytes - item.bytes);
      item.reject(reason);
    }
    this.notifyIdle();
  }

  /**
   * Wait for the active write and every queued continuation. With a timeout,
   * returns false instead of trusting a transport callback that may never
   * arrive after a half-open socket.
   */
  async waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (this._pendingWrites === 0) return true;

    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
      this.idleWaiters.add(resolve);
    });
    if (
      typeof timeoutMs !== 'number'
      || !Number.isFinite(timeoutMs)
      || timeoutMs < 0
    ) {
      await idle;
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        idle.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.idleWaiters.delete(resolveIdle);
    }
  }

  private notifyIdle(): void {
    if (this._pendingWrites !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export function streamQueueLimits(
  env: NodeJS.ProcessEnv = process.env,
): { maxPendingWrites: number; maxPendingBytes: number } {
  return {
    maxPendingWrites: positiveLimit(
      Number(env.MCP_STREAM_MAX_PENDING_WRITES),
      DEFAULT_STREAM_MAX_PENDING_WRITES,
    ),
    maxPendingBytes: positiveLimit(
      Number(env.MCP_STREAM_MAX_PENDING_BYTES),
      DEFAULT_STREAM_MAX_PENDING_BYTES,
    ),
  };
}

export function streamDrainTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveLimit(
    Number(env.MCP_STREAM_DRAIN_TIMEOUT_MS),
    DEFAULT_STREAM_DRAIN_TIMEOUT_MS,
  );
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizedBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function abortError(): Error {
  const error = new Error('stream writer aborted');
  error.name = 'AbortError';
  return error;
}
