/**
 * Bounds for the untrusted numbers a `dbClient` request can carry.
 *
 * Every field here crosses the IPC channel from the renderer, so it is
 * attacker-shaped in exactly the same way an HTTP body is: a compromised (or
 * merely buggy) caller can ask for a 10-billion-row page. These handlers run in
 * the Electron MAIN process, so an unbounded fetch is not a slow query — it is
 * the whole app dying with the connection pools, the SSH tunnels and every
 * unsaved editor buffer inside it. Clamp instead of trusting, and reject
 * outright only where a silent clamp would hide a real mistake (the deadline).
 */
import { ApiError } from '@mcp/api-bus';

/** Keep an interactive query bounded while still allowing reports to finish. */
export const MIN_QUERY_TIMEOUT_MS = 1_000;
export const MAX_QUERY_TIMEOUT_MS = 60 * 60_000;

/**
 * Hard ceiling on rows materialized into one response. Well above any paged UI
 * (the grid tops out at 500/page) and above the default 1 000 cap, so a
 * deliberate "give me everything" still works — but bounded. Unbounded exports
 * have their own streaming path (`exportStream`/`dumpStream`), which never
 * holds a whole table in memory.
 */
export const MAX_RESULT_ROWS = 100_000;

/** Largest page a table preview may request (the +1 look-ahead rides on top). */
export const MAX_PAGE_LIMIT = 10_000;

/** Validate an untrusted per-query deadline before handing it to a driver. */
export function parseQueryTimeoutMs(timeoutMs: unknown): number | undefined {
  if (timeoutMs == null) return undefined;
  if (
    typeof timeoutMs !== 'number'
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_QUERY_TIMEOUT_MS
    || timeoutMs > MAX_QUERY_TIMEOUT_MS
  ) {
    throw new ApiError(
      'db_invalid_query_timeout',
      400,
      `Query timeout must be an integer between ${MIN_QUERY_TIMEOUT_MS}ms and ${MAX_QUERY_TIMEOUT_MS}ms.`,
    );
  }
  return timeoutMs;
}

/**
 * Clamp a requested row cap into `[1, MAX_RESULT_ROWS]`. `undefined` stays
 * undefined so the driver applies its own default; a non-finite or negative
 * value collapses to 1 rather than to "unbounded".
 */
export function clampMaxRows(maxRows: unknown): number | undefined {
  if (maxRows == null) return undefined;
  const n = Math.floor(Number(maxRows));
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), MAX_RESULT_ROWS);
}

/** Clamp a page size into `[1, MAX_PAGE_LIMIT]` (missing/garbage → 100). */
export function clampPageLimit(limit: unknown): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return 100;
  return Math.min(Math.max(n, 1), MAX_PAGE_LIMIT);
}

/** Clamp a page offset to a non-negative safe integer (missing/garbage → 0). */
export function clampOffset(offset: unknown): number {
  const n = Math.floor(Number(offset));
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}
