export interface SqliteWriteQueueOptions {
  label?: string;
  maxPending?: number;
  maxWaitMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onRetry?: (event: {
    label: string;
    attempt: number;
    delayMs: number;
    elapsedMs: number;
    error: unknown;
  }) => void;
}

export class SqliteWriteQueueFullError extends Error {
  readonly code = 'sqlite_write_queue_full';

  constructor(label: string, maxPending: number) {
    super(`${label} SQLite write queue is full (${maxPending} pending operations)`);
    this.name = 'SqliteWriteQueueFullError';
  }
}

export function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_BUSY_SNAPSHOT'
    || /database is (?:locked|busy)/i.test(message);
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * One strictly ordered writer for synchronous better-sqlite3 mutations.
 *
 * Every attempt itself must be configured to fail fast (`busy_timeout=0`).
 * Contention waits happen here, through timers, so Electron-main keeps
 * processing renderer IPC/SSE while another connection owns the WAL writer.
 */
export class SqliteWriteQueue {
  private readonly label: string;
  private readonly maxPending: number;
  private readonly maxWaitMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onRetry?: SqliteWriteQueueOptions['onRetry'];
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(options: SqliteWriteQueueOptions = {}) {
    this.label = options.label ?? 'main-thread';
    this.maxPending = Math.max(1, Math.floor(options.maxPending ?? 256));
    this.maxWaitMs = Math.max(0, Math.floor(options.maxWaitMs ?? 30_000));
    this.retryBaseMs = Math.max(1, Math.floor(options.retryBaseMs ?? 25));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.floor(options.retryMaxMs ?? 500));
    this.onRetry = options.onRetry;
  }

  get pendingWrites(): number {
    return this.pending;
  }

  run<T>(operation: () => T): Promise<T> {
    if (this.pending >= this.maxPending) {
      return Promise.reject(new SqliteWriteQueueFullError(this.label, this.maxPending));
    }
    this.pending += 1;

    const execute = async (): Promise<T> => {
      const startedAt = Date.now();
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          return operation();
        } catch (error) {
          const elapsedMs = Date.now() - startedAt;
          if (!isSqliteBusyError(error) || elapsedMs >= this.maxWaitMs) throw error;
          const delayMs = Math.min(
            this.retryMaxMs,
            this.retryBaseMs * (2 ** Math.min(attempt - 1, 8)),
          );
          try {
            this.onRetry?.({ label: this.label, attempt, delayMs, elapsedMs, error });
          } catch {
            // Diagnostics must never poison the durability queue.
          }
          await wait(delayMs);
        }
      }
    };

    const result = this.tail.then(execute, execute);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending = Math.max(0, this.pending - 1);
    });
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
