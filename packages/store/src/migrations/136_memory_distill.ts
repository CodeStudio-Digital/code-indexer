/**
 * Migration 136 — memory distillation diagnostics + idle high-water mark.
 *
 * `memory_distill_log` records every distillation attempt per project
 * (trigger, status, created/merged/skipped counts, error) so the project
 * Memory tab can show "memory health" instead of the pipeline failing
 * silently — the original sin that made project memory look dead.
 *
 * `coder_sessions.memory_distilled_message_id` is the high-water mark of the
 * last message already covered by a distillation. The compaction harvest
 * advances it; the idle sweeper distills only the span PAST it, so a session
 * is never re-distilled from scratch and a poison session can't wedge the
 * sweep (the mark advances even on error).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const memoryDistill136: Migration = {
  version: 136,
  name: 'memory_distill',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_distill_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        session_id INTEGER,
        trigger    TEXT NOT NULL,
        status     TEXT NOT NULL,
        created    INTEGER NOT NULL DEFAULT 0,
        merged     INTEGER NOT NULL DEFAULT 0,
        skipped    INTEGER NOT NULL DEFAULT 0,
        error      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_distill_log_project
        ON memory_distill_log(project_id, id DESC);
    `);

    addColumnIfMissing(
      db,
      'coder_sessions',
      'memory_distilled_message_id',
      'INTEGER NOT NULL DEFAULT 0',
    );
  },
};
