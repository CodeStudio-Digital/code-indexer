/**
 * Migration 143 — per-turn prompt-cache diagnostics on `coder_turn_telemetry`.
 *
 * When the provider-reported cache hit drops between turns, these columns
 * pinpoint WHICH prefix segment diverged without replaying requests:
 *
 *  - `tools_fingerprint`  — SHA-1 of the serialized tools array (1st cache
 *    segment). Changed → toolset membership/bytes flipped.
 *  - `prefix_head_hash`   — SHA-1 sample of the first messages of the
 *    assembled history. Changed (with stable fingerprint) → an old message
 *    was mutated in place (rolling reducer, compaction splice…).
 *  - `reducer_retired_count` / `reducer_freed_chars` — retirements APPLIED by
 *    the rolling reducer this turn (a non-zero count explains a head change).
 *  - `reducer_pending_chars` — retirements detected but deferred by the
 *    tranche flush threshold (CODER_REDUCER_FLUSH_CHARS).
 *
 * Idempotent (`addColumnIfMissing`) — pattern of migrations 129/130/131.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const turnCacheDiagnostics143: Migration = {
  version: 143,
  name: 'turn_cache_diagnostics',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_turn_telemetry', 'tools_fingerprint', 'TEXT');
    addColumnIfMissing(db, 'coder_turn_telemetry', 'prefix_head_hash', 'TEXT');
    addColumnIfMissing(db, 'coder_turn_telemetry', 'reducer_retired_count', 'INTEGER');
    addColumnIfMissing(db, 'coder_turn_telemetry', 'reducer_freed_chars', 'INTEGER');
    addColumnIfMissing(db, 'coder_turn_telemetry', 'reducer_pending_chars', 'INTEGER');
  },
};
