/** Migration 216 — real pause/resume and adjustable extraction workers. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function addColumn(db: DB, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const docIngestPauseWorkers216: Migration = {
  version: 216,
  name: 'doc_ingest_pause_workers',
  outsideTransaction: true,
  up: (db: DB): void => {
    if (!tableExists(db, 'doc_ingest_runs')) return;
    const foreignKeys = Number(db.pragma('foreign_keys', { simple: true })) !== 0;
    if (foreignKeys) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        addColumn(db, 'doc_sources', 'folder_performance_profile', `TEXT NOT NULL DEFAULT 'balanced'`);
        addColumn(db, 'doc_sources', 'folder_worker_count', 'INTEGER');

        const runColumns = db.prepare(`PRAGMA table_info(doc_ingest_runs)`).all() as Array<{ name: string }>;
        if (runColumns.some((row) => row.name === 'pause_requested')) return;

        db.exec(`
          DROP INDEX IF EXISTS idx_doc_ingest_runs_source;
          DROP INDEX IF EXISTS idx_doc_ingest_runs_active;
          CREATE TABLE doc_ingest_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL REFERENCES doc_sources(id) ON DELETE CASCADE,
            state TEXT NOT NULL DEFAULT 'running'
              CHECK(state IN ('running','paused','paused_limit','cancelled','completed','failed')),
            phase TEXT NOT NULL DEFAULT 'fetching',
            options_json TEXT,
            total_items INTEGER NOT NULL DEFAULT 0,
            processed_items INTEGER NOT NULL DEFAULT 0,
            changed_items INTEGER NOT NULL DEFAULT 0,
            unchanged_items INTEGER NOT NULL DEFAULT 0,
            skipped_items INTEGER NOT NULL DEFAULT 0,
            errored_items INTEGER NOT NULL DEFAULT 0,
            chunks_persisted INTEGER NOT NULL DEFAULT 0,
            embeddings_completed INTEGER NOT NULL DEFAULT 0,
            enrichments_completed INTEGER NOT NULL DEFAULT 0,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            pause_requested INTEGER NOT NULL DEFAULT 0,
            performance_profile TEXT NOT NULL DEFAULT 'balanced',
            worker_count INTEGER NOT NULL DEFAULT 1,
            error_message TEXT,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT
          );
          INSERT INTO doc_ingest_runs_new(
            id,source_id,state,phase,options_json,total_items,processed_items,changed_items,
            unchanged_items,skipped_items,errored_items,chunks_persisted,embeddings_completed,
            enrichments_completed,cancel_requested,error_message,started_at,heartbeat_at,completed_at
          ) SELECT
            id,source_id,state,phase,options_json,total_items,processed_items,changed_items,
            unchanged_items,skipped_items,errored_items,chunks_persisted,embeddings_completed,
            enrichments_completed,cancel_requested,error_message,started_at,heartbeat_at,completed_at
          FROM doc_ingest_runs;
          DROP TABLE doc_ingest_runs;
          ALTER TABLE doc_ingest_runs_new RENAME TO doc_ingest_runs;
          CREATE INDEX idx_doc_ingest_runs_source ON doc_ingest_runs(source_id, id DESC);
          CREATE INDEX idx_doc_ingest_runs_active ON doc_ingest_runs(state, heartbeat_at);
        `);
      });
      tx();
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) throw new Error(`foreign_key_check found ${violations.length} violation(s)`);
    } finally {
      if (foreignKeys) db.pragma('foreign_keys = ON');
    }
  },
};
