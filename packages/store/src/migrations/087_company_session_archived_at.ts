/**
 * Migration 087 — `archived_at` on `company_sessions` for true soft-delete.
 *
 * `archiveCompanySession()` was designed as a "snapshot + reset" operation:
 * it preserves the session row and resets status to `idle`, intended for
 * the parent session's reset flow. When sub-sessions ("fronts") shipped
 * in migration 067, the same method was reused to "archive a front",
 * but `listChildSessions()` returned EVERY child regardless of status,
 * so an archived front reappeared the next time the dashboard loaded.
 *
 * Adding a nullable `archived_at` lets us soft-delete the row without
 * touching the existing CHECK constraint on `status`. The query filter
 * (`WHERE archived_at IS NULL`) lives in `listChildSessions`; archival
 * writes the timestamp and never resurrects it.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export const companySessionArchivedAt087: Migration = {
  version: 87,
  name: 'company_session_archived_at',
  up: (db: DB): void => {
    if (!columnExists(db, 'company_sessions', 'archived_at')) {
      db.exec(`ALTER TABLE company_sessions ADD COLUMN archived_at TEXT`);
    }
  },
};
