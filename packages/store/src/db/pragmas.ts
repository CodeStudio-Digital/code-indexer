/**
 * Shared SQLite tuning pragmas for the index DB and the sqlite-vec store.
 *
 * Defaults live IN CODE (env vars are operator overrides only):
 *  - busy_timeout 5000 — index.db is opened by several connections (server,
 *    dbWriter worker, a concurrent CLI). Under WAL, writer-vs-writer contention
 *    raises SQLITE_BUSY immediately without a timeout; 5s turns an error into
 *    a short wait. Transactions here are all short-lived.
 *    CAVEAT: that reasoning holds only OFF the main thread. better-sqlite3
 *    waits inside a synchronous native call, so on the Electron main thread the
 *    ceiling is a hard bound on how long every window can freeze — several
 *    contended calls in one turn is how a 30s hang gets built out of "short"
 *    waits. The main-process handle therefore passes a small `busyTimeoutMs`
 *    (see `mainBusyTimeoutMs` in apps/http-api/server/deps.ts) and the few
 *    writes that must wait re-raise it per operation via `withBusyTimeout`.
 *  - temp_store MEMORY — temp b-trees (ORDER BY / GROUP BY / FTS merges) stay
 *    in RAM instead of temp files, which on Windows also dodges Defender
 *    scanning. Indexer queries are small and paginated, so the RAM cost is
 *    negligible.
 *  - mmap_size 256MB — reads go through memory-mapped pages instead of
 *    read() + copy. NOTE: touched mapped pages count toward apparent RSS but
 *    are reclaimable page cache — compare memory metrics only across equal
 *    configs. `MCP_SQLITE_MMAP_MB=0` disables.
 */

interface PragmaRunner {
  pragma(sql: string): unknown;
}

export interface TuningPragmaOptions {
  busyTimeoutMs?: number;
  mmapBytes?: number;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_MMAP_BYTES = 256 * 1024 * 1024;

const envInt = (name: string): number | null => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * The mmap budget a tuned connection will map, in bytes. Exported so the perf
 * ledger can report `connections × budget` instead of leaving those pages in
 * `unattributedRssMB` — mapped pages are reclaimable page cache, but they still
 * inflate the working set of whichever process holds the handle.
 */
export function resolveTuningMmapBytes(opts?: TuningPragmaOptions): number {
  if (opts?.mmapBytes !== undefined) return opts.mmapBytes;
  const envMmapMb = envInt('MCP_SQLITE_MMAP_MB');
  return envMmapMb !== null ? envMmapMb * 1024 * 1024 : DEFAULT_MMAP_BYTES;
}

export function applyTuningPragmas(db: PragmaRunner, opts?: TuningPragmaOptions): void {
  const busyTimeoutMs = opts?.busyTimeoutMs
    ?? envInt('MCP_SQLITE_BUSY_TIMEOUT_MS')
    ?? DEFAULT_BUSY_TIMEOUT_MS;
  const mmapBytes = resolveTuningMmapBytes(opts);

  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('temp_store = MEMORY');
  db.pragma(`mmap_size = ${mmapBytes}`);
}
