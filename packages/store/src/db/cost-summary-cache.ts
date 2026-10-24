import type { DB } from './types.js';
import type { CostSummary } from '@mcp/shared/types.js';

const caches = new WeakMap<DB, Map<string, { revision: string; value: CostSummary }>>();

/** Ledger summaries are immutable projections. Local changes and commits made
 * by another connection invalidate them; a read transaction keeps aggregates
 * internally consistent. Each connection retains at most 32 small summaries. */
export function costSummary(db: DB, key: string, read: () => CostSummary): CostSummary {
  // total_changes does not roll back. Never publish an uncommitted projection
  // into a connection cache that may survive an outer transaction's rollback.
  if (db.inTransaction) return read();
  return db.transaction(() => {
    const revision = String(db.pragma('data_version', { simple: true })) + ':'
      + (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    let cache = caches.get(db); if (!cache) { cache = new Map(); caches.set(db, cache); }
    const hit = cache.get(key);
    if (hit?.revision === revision) return structuredClone(hit.value);
    const value = read();
    // A very large per-project/provider breakdown remains available in full,
    // but cannot permanently inflate the process-local cache.
    cache.delete(key);
    if (Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024) {
      cache.set(key, { revision, value: structuredClone(value) });
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    return value;
  })();
}
