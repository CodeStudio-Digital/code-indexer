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
 * `refetch()` always revalidates and any
 * mutation calls `invalidateAll()`. 1500ms comfortably covers a single
 * render pass + a remount within the same interaction without ever
 * letting a value visibly age.
 */
const TTL_MS = 1500;

interface CacheEntry {
  data: unknown;
  at: number;
  bytes: number;
}

const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, CacheEntry>();
const inflightOnly = new Map<string, Promise<unknown>>();
// Entry count is a hard limit. The payload estimate is an additional budget,
// not a claim about the VM's exact heap layout. Large or complex bodies still
// share their in-flight request, but are not retained after it settles.
const MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_VISITED_VALUES = 4096;
let cacheBytes = 0;
let generation = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let expiryDeadline = Infinity;

function estimateBytes(value: unknown, key: string): number {
  let bytes = key.length * 2 + 64;
  let visited = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++visited > MAX_VISITED_VALUES || depth > 32) { bytes = Infinity; return; }
    if (typeof item === 'string') { bytes += item.length * 2 + 16; return; }
    if (item == null || typeof item === 'number' || typeof item === 'boolean') { bytes += 8; return; }
    if (typeof item !== 'object') { bytes = Infinity; return; }
    if (seen.has(item)) return;
    seen.add(item);
    bytes += 64;
    if (Array.isArray(item)) {
      if (item.length > MAX_VISITED_VALUES - visited) { bytes = Infinity; return; }
      for (const child of item) {
        visit(child, depth + 1);
        if (bytes > MAX_ENTRY_BYTES) return;
      }
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) { bytes = Infinity; return; }
      for (const name in item) {
        if (!Object.hasOwn(item, name)) continue;
        bytes += name.length * 2 + 16;
        visit((item as Record<string, unknown>)[name], depth + 1);
        if (bytes > MAX_ENTRY_BYTES) return;
      }
    }
  }
  if (bytes <= MAX_ENTRY_BYTES) visit(value, 0);
  return bytes;
}

function removeCached(key: string): void {
  const entry = cache.get(key);
  if (entry) { cacheBytes -= entry.bytes; cache.delete(key); }
}

/** One deadline timer, only while bodies are resident; no idle polling. */
function scheduleExpiry(): void {
  let deadline = Infinity;
  for (const entry of cache.values()) deadline = Math.min(deadline, entry.at + TTL_MS + 1);
  if (expiryTimer !== undefined && expiryDeadline <= deadline && deadline !== Infinity) return;
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  expiryDeadline = deadline;
  if (deadline === Infinity) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    expiryDeadline = Infinity;
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.at > TTL_MS) removeCached(key);
    }
    scheduleExpiry();
  }, Math.max(1, deadline - Date.now()));
}

function cacheValue(key: string, data: unknown): void {
  removeCached(key);
  let bytes: number;
  try { bytes = estimateBytes(data, key); } catch { bytes = Infinity; }
  if (key && bytes <= MAX_ENTRY_BYTES) {
    const now = Date.now();
    for (const [existingKey, entry] of cache) {
      if (now - entry.at > TTL_MS) removeCached(existingKey);
    }
    while (cache.size >= MAX_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      removeCached(oldest.value);
    }
    cache.set(key, { data, at: now, bytes });
    cacheBytes += bytes;
  }
  scheduleExpiry();
}
/** Fresh cached body for `key`, or undefined (miss/expired). Empty key never hits. */
export function getCached<T>(key: string): T | undefined {
  if (!key) return undefined;
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) {
    removeCached(key);
    scheduleExpiry();
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

  const startedInGeneration = generation;
  const p = producer()
    .then((data) => {
      if (generation === startedInGeneration) cacheValue(key, data);
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

/**
 * Collapse concurrent identical reads into ONE round-trip WITHOUT caching
 * the result. The moment the shared promise settles the slot is cleared, so
 * the next call re-fetches — correct for live reads whose freshness comes
 * from fs-events (file tree, file content) and must NOT be served stale even
 * for the 1500ms `dedupe` window. Errors are never retained either.
 */
export function dedupeInflight<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const existing = inflightOnly.get(key);
  if (existing) return existing as Promise<T>;
  const p = producer().finally(() => {
    inflightOnly.delete(key);
  });
  inflightOnly.set(key, p);
  return p as Promise<T>;
}

/** Refresh an already-live cache entry after an optimistic update. Never
 *  resurrects an expired key or creates a phantom for an unfetched one. */
export function writeThrough(key: string, data: unknown): void {
  if (!key) return;
  const entry = cache.get(key);
  if (!entry) return;
  if (Date.now() - entry.at > TTL_MS) { removeCached(key); scheduleExpiry(); return; }
  cacheValue(key, data);
}

/** Drop every cached body. Called on any successful mutation. */
export function invalidateAll(): void {
  generation += 1;
  cache.clear();
  cacheBytes = 0;
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  expiryDeadline = Infinity;
}
