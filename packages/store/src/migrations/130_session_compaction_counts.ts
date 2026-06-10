/**
 * Migration 130 — durable-compaction counters on `coder_sessions`.
 *
 * Two lifetime counters so the metrics panel can answer "how many times was
 * this session summarized?", split by origin. BOTH the automatic durable
 * compaction (`runDurableCompaction`, end of run) and the manual "summarize &
 * clear" funnel through `setCompactionBoundary`, which bumps the matching
 * counter atomically with the boundary move. Forward-only: sessions compacted
 * before these columns existed read 0 — we can't reconstruct the historical
 * count, and faking one would be dishonest.
 *
 * Idempotent (`addColumnIfMissing`) so it's a no-op where the columns already
 * exist — same repair-friendly pattern as migration 129.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionCompactionCounts130: Migration = {
  version: 130,
  name: 'session_compaction_counts',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'compaction_count_auto', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'coder_sessions', 'compaction_count_manual', 'INTEGER NOT NULL DEFAULT 0');
  },
};
