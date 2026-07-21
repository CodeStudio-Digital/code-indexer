/** Migration 246 — covering indexes for the session-open + launch-dialog hot paths. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

export const perfIndexes246: Migration = {
  version: 246,
  name: 'perf_indexes',
  up(db: DB): void {
    // Both tables are central-only; per-project databases intentionally TRIM
    // them, so each block must no-op when its table is absent (mig 234 pattern).
    if (tableExists(db, 'coder_messages')) {
      // Role-filtered lookups on the session-open path: previousUserMessageId /
      // getFirstUserText (`role = 'user'`) match the prefix directly, and the
      // loadTail/loadBefore cutoff runs one COVERING branch per role merged by
      // id — instead of probing the table row of every trailing message just
      // to evaluate `role != 'tool'`.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_coder_messages_session_role
          ON coder_messages(session_id, role, id)
      `);
    }
    if (tableExists(db, 'coder_sessions')) {
      // favorite_updated: ordering prefix of every session listing
      // (`ORDER BY is_favorite DESC, updated_at DESC`) — the LIMITed global
      // lists (listRecentGlobal) previously sorted the whole table.
      //
      // updated: carries `id DESC` on purpose — getLastUsedProviderModel
      // orders by (updated_at DESC, id DESC), and without the tie-break
      // column SQLite ignores the index and falls back to a full scan +
      // temp B-tree sort instead of stopping at the first indexed row.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_coder_sessions_favorite_updated
          ON coder_sessions(is_favorite DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_coder_sessions_updated
          ON coder_sessions(updated_at DESC, id DESC);
      `);
    }
  },
};
