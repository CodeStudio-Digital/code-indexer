/**
 * Migration 214 — resumable, incremental documentation ingestion.
 *
 * Legacy rows remain valid: stable_key/item_key are nullable and are filled
 * lazily the next time a source is indexed.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function addColumn(db: DB, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const docIngestGenerations214: Migration = {
  version: 214,
  name: 'doc_ingest_generations',
  up: (db: DB): void => {
    if (!tableExists(db, 'doc_sources') || !tableExists(db, 'doc_chunks')) return;

    addColumn(db, 'doc_sources', 'enrichment_mode', `TEXT NOT NULL DEFAULT 'selective'`);
    addColumn(db, 'doc_sources', 'embedding_fingerprint', 'TEXT');
    addColumn(db, 'doc_sources', 'last_ingest_run_id', 'INTEGER');

    addColumn(db, 'doc_chunks', 'stable_key', 'TEXT');
    addColumn(db, 'doc_chunks', 'item_key', 'TEXT');
    addColumn(db, 'doc_chunks', 'ingest_run_id', 'INTEGER');
    addColumn(db, 'doc_chunks', 'embedding_input_hash', 'TEXT');
    addColumn(db, 'doc_chunks', 'embedding_fingerprint', 'TEXT');
    addColumn(db, 'doc_chunks', 'enrichment_fingerprint', 'TEXT');
    addColumn(db, 'doc_chunks', 'updated_at', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_ingest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES doc_sources(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'running'
          CHECK(state IN ('running','paused_limit','cancelled','completed','failed')),
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
        error_message TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_doc_ingest_runs_source
        ON doc_ingest_runs(source_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_doc_ingest_runs_active
        ON doc_ingest_runs(state, heartbeat_at);

      CREATE TABLE IF NOT EXISTS doc_source_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES doc_sources(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        source_uri TEXT,
        size_bytes INTEGER,
        mtime_ms INTEGER,
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_seen_run_id INTEGER REFERENCES doc_ingest_runs(id) ON DELETE SET NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_id, item_key)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_source_items_run
        ON doc_source_items(source_id, last_seen_run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_chunks_stable_key
        ON doc_chunks(source_id, stable_key) WHERE stable_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_item_key
        ON doc_chunks(source_id, item_key);
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding_fingerprint
        ON doc_chunks(source_id, embedding_fingerprint);
    `);
  },
};
