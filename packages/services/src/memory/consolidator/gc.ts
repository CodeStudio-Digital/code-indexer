import type { ConsolSnapshot, ConsolidatorOptions } from './types.js';

/**
 * Garbage-collection selection for the consolidator (pure).
 *
 * A snapshot is archivable only when ALL THREE hold — a deliberately
 * conservative gate so durable, still-relevant memory is never swept:
 *   1. fully stale — every referenced file changed/deleted (and it HAS
 *      referenced files; rows with none can't be assessed → never archived);
 *   2. low importance — below the GC ceiling (under every category floor);
 *   3. cold — untouched for `archiveUnusedDays` AND accessed ≤ `archiveMaxAccess`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Never auto-archived, regardless of staleness/coldness: user identity and
 *  stated preferences are the highest-value memory kind and only the USER
 *  retires them (explicit archive in the UI / forget_memory). */
const PROTECTED_CATEGORIES = new Set(['user', 'feedback', 'preference']);
/** Pins carry explicit user intent — the GC never overrides them. */
const PIN_IMPORTANCE = 0.9;

function ageDays(ts: string | null, nowMs: number): number {
  if (!ts) return Infinity; // never accessed → treat as maximally cold
  const parsed = Date.parse(`${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed)) return Infinity;
  return Math.max(0, nowMs - parsed) / DAY_MS;
}

export interface ArchiveTarget {
  id: number;
  reason: string;
}

export function selectArchivable(
  snaps: ConsolSnapshot[],
  staleMap: Map<number, { stale: string[]; total: number }>,
  opts: ConsolidatorOptions,
  nowMs: number,
): ArchiveTarget[] {
  const out: ArchiveTarget[] = [];
  for (const s of snaps) {
    // Explicit protections (previously only implicit via the importance
    // ceiling): preferences/user facts and pinned rows are user territory.
    if (s.category && PROTECTED_CATEGORIES.has(s.category)) continue;
    if ((s.importance ?? 0.5) >= PIN_IMPORTANCE) continue;

    const files = staleMap.get(s.id);
    // No referenced files → can't assess staleness → never auto-archive.
    if (!files || files.total === 0) continue;
    const fullyStale = files.stale.length === files.total;
    if (!fullyStale) continue;

    if ((s.importance ?? 0.5) >= opts.archiveImportanceMax) continue;

    const cold =
      ageDays(s.last_accessed_at ?? s.created_at, nowMs) >= opts.archiveUnusedDays &&
      (s.access_count ?? 0) <= opts.archiveMaxAccess;
    if (!cold) continue;

    out.push({ id: s.id, reason: 'stale+cold+low-importance' });
  }
  return out;
}
