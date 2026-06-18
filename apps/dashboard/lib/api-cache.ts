/**
 * Shared GET/read layer: in-flight promise dedup + short-TTL response
 * cache, both keyed by an opaque string. Collapses concurrent and
 * near-concurrent identical reads into ONE round-trip and lets a late
 * mounter skip the request entirely while a body is still fresh.
 *
 * Used by BOTH transports:
 *   - `useApi` (HTTP)          → key `GET <fullUrl>`     (hooks/useApi.ts)
 *   - `apiCall` (Electron IPC) → key `CALL <verb> <json>` (lib/api-client.ts)
 *
 * Lives in `lib/` (not `hooks/`) so the transport layer can import it without
 * a hooks→lib→hooks edge. Deliberately DEPENDENCY-FREE: callers build their
 * own key, so it never imports the transport that imports it.
 *
 * Deliberately NOT here: AbortController. The in-flight promise is shared,
 * so one consumer unmounting must NOT abort it — consumers ignore the
 * result via their own `cancelled` flag instead.
 *
 * Stores the already-resolved value (a Response body is single-use and
 * cannot be shared across consumers).
 */

/**
 * TTL for cached bodies. Short on purpose: this cache exists to collapse
 * the burst of identical reads fired when a route mounts a tree of
 * components (e.g. /projects/:id from App + AppShell + ProjectView) and
 * quick back/forward navigation — NOT to serve stale data over time.
 * Freshness is guaranteed by two stronger mechanisms that bypass it:
 * `refetch()` always revalidates (the 2.5s pipeline poll uses it) and any
 * mutation calls `invalidateAll()`. 1500ms comfortably covers a single
 * render pass + a remount within the same interaction without ever
 * letting a value visibly age.
 */
const TTL_MS = 1500;

interface CacheEntry {
  data: unknown;
  at: number;
}

const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, CacheEntry>();

/** Fresh cached body for `key`, or undefined (miss/expired). Empty key never hits. */
export function getCached<T>(key: string): T | undefined {
  if (!key) return undefined;
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

/**
 * Run `producer` through the dedup layer. Concurrent callers for the same
 * key share ONE promise. On success the value is cached; on failure
 * nothing is cached and the in-flight slot is cleared so the next call
 * retries. Errors are never cached.
 */
export function dedupe<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const p = producer()
    .then((data) => {
      cache.set(key, { data, at: Date.now() });
      return data;
    })
    .finally(() => {
      // Clear whether resolved or rejected: errors are never cached, and a
      // settled success is now served from `cache`.
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p as Promise<T>;
}

/** Refresh an already-live cache entry after an optimistic update. Never
 *  resurrects an expired key or creates a phantom for an unfetched one. */
export function writeThrough(key: string, data: unknown): void {
  if (!key) return;
  if (cache.has(key)) cache.set(key, { data, at: Date.now() });
}

/** Drop every cached body. Called on any successful mutation. */
export function invalidateAll(): void {
  cache.clear();
}
