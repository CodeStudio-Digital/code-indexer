/**
 * Migration 137 — `files.mtime_ms` for the stat-first scanner.
 *
 * The scanner used to read + SHA-256 EVERY candidate file on EVERY scan to
 * decide changed/unchanged. With mtime_ms (+ the existing `size`) persisted,
 * an unchanged file is detected from `fs.stat` alone — zero bytes read.
 * NULL means "unknown" and forces the read+hash fallback, which then stamps
 * the column (`touchMtime`) — i.e. the backfill is automatic, no data
 * migration needed.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const filesMtime137: Migration = {
  version: 137,
  name: 'files_mtime',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'files', 'mtime_ms', 'INTEGER');
  },
};
