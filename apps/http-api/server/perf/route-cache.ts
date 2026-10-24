/**
 * Tiny synchronous TTL cache for the hottest GET route handlers.
 *
 * better-sqlite3 reads run on the single main-thread event loop, so the
 * dashboard's duplicated / SSE-tick-driven polls (the freeze report shows two
 * `state-summary`, two `state-snapshot`, etc. firing nearly together) each
 * re-run the same synchronous reads and pile onto the loop during a multi-agent
 * run. Memoizing for a few hundred ms collapses that burst into one read.
 *
 * SHORT TTL + self-heal, NOT invalidate-on-write, on purpose: during a run the
 * agent's writes go through the WORKER's own DB connection and can never be
 * observed by a main-side cache anyway; the live truth reaches the dashboard
 * over SSE, and the poll is only a periodic reconciliation. So sub-second
 * staleness is invisible and self-heals on the next poll. `MCP_HOT_READ_CACHE_MS`
 * tunes the TTL; `0` disables (every call recomputes).
 *
 * Injectable clock keeps it unit-testable without real time.
 */
export class RouteCache {
  private readonly store = new Map<string, { value: unknown; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Return the cached value if fresh, else compute, store, and return it. */
  get<T>(key: string, ttlMs: number, compute: () => T): T {
    const hit = this.store.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;
    const value = compute();
    this.store.set(key, { value, at: this.now() });
    return value;
  }

  /** Drop one exact key (e.g. after a main-side mutation that must show now). */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Default TTL for hot-read route caches. ~300ms is below human perception for a
 * reconciliation poll yet long enough to collapse the duplicate concurrent
 * bursts. Set `MCP_HOT_READ_CACHE_MS=0` to disable caching entirely.
 */
const HOT_READ_TTL_MS = (() => {
  const raw = process.env.MCP_HOT_READ_CACHE_MS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300;
})();
