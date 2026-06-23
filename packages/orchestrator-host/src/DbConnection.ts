/**
 * Per-worker SQLite handle opened in WAL mode so multiple workers can
 * read concurrently without blocking each other. Each worker thread
 * opens its OWN `better-sqlite3` connection to the same file — WAL
 * tolerates many concurrent readers and serializes writes via the
 * `-shm` / `-wal` sidecar files.
 *
 * Pragmas:
 *   - `journal_mode = WAL` — concurrent reads + single writer
 *   - `synchronous = NORMAL` — durable enough for our workload; FULL is
 *     overkill given we already lose in-flight state on crash
 *   - `busy_timeout = 5000` — wait up to 5s before SQLITE_BUSY when a
 *     write is in flight; covers normal contention without surfacing
 *     errors that would have succeeded with a brief retry
 *   - `foreign_keys = ON` — match the migration runner expectation
 *
 * Lifecycle:
 *   - `open()` is idempotent — repeated calls return the same handle
 *   - `close()` is called from the worker's `process.on('exit')` so a
 *     crash still flushes the WAL; the OS reclaims fd's either way
 *
 * NOTE: this module is *worker-side only*. Importing it on the main
 * thread is allowed (the pragmas are the same) but the main DB handle
 * is owned by `apps/http-api/server.ts` and uses its own initializer.
 */
import DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface DbConnectionOpts {
  /** Absolute path to the SQLite file (matches the main process's `DB_PATH`). */
  dbPath: string;
  /** Override default busy timeout; usually leave at 5000. */
  busyTimeoutMs?: number;
  /** When true, opens the DB read-only (sub-orchestrators reading shared rows). */
  readonly?: boolean;
}

export class DbConnection {
  private db: DB | null = null;
  private readonly opts: DbConnectionOpts;

  constructor(opts: DbConnectionOpts) {
    this.opts = opts;
  }

  open(): DB {
    if (this.db) return this.db;
    const db = new DatabaseConstructor(this.opts.dbPath, {
      readonly: !!this.opts.readonly,
    });
    // Always enable WAL — even read-only handles benefit because they
    // won't block the main-thread writer.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${this.opts.busyTimeoutMs ?? 5000}`);
    db.pragma('foreign_keys = ON');
    this.db = db;
    return db;
  }

  /** Returns the underlying handle; opens lazily. */
  get handle(): DB {
    return this.open();
  }

  /** Idempotent. Safe in shutdown hooks. */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch { /* best-effort during shutdown */ }
    this.db = null;
  }
}

/**
 * Convenience helper for worker entry points. Opens the DB and
 * registers a `process.on('exit', ...)` hook to close it. Returns the
 * handle so the caller can wire it into stores.
 *
 *   const db = openWorkerDb({ dbPath: process.env.MCP_DB_PATH! });
 */
export function openWorkerDb(opts: DbConnectionOpts): DbConnection {
  const conn = new DbConnection(opts);
  conn.open();
  const shutdown = (): void => conn.close();
  process.on('exit', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return conn;
}
