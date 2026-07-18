/** Migration 227 — local-first semantic indexing control plane. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const DEFAULT_EMBEDDING = JSON.stringify({
  kind: 'onnx',
  model: 'Xenova/multilingual-e5-small',
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
  queryTemplate: 'query: {text}',
  documentTemplate: 'passage: {text}',
  maxTokens: 512,
});

const DEFAULT_RERANKER = JSON.stringify({
  kind: 'onnx',
  model: 'auto',
  dtype: 'q8',
  maxTokens: 512,
});

function isTrimmedProjectDb(db: DB): boolean {
  const meta = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_db_meta'`,
  ).get();
  if (!meta) return false;
  return !!db.prepare(
    `SELECT 1 FROM project_db_meta WHERE key = 'trim_version'`,
  ).get();
}

function tableExists(db: DB, name: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name);
}

export const semanticIndexing227: Migration = {
  version: 227,
  name: 'semantic_indexing',
  up(db: DB): void {
    // These tables are central-only. An already-trimmed project DB still runs
    // the central migration lineage on upgrade, so it must not recreate them.
    if (isTrimmedProjectDb(db)) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_profiles (
        purpose TEXT PRIMARY KEY CHECK (purpose IN ('code', 'docs', 'memory')),
        embedding_target TEXT NOT NULL CHECK (json_valid(embedding_target)),
        reranker_target TEXT NOT NULL CHECK (json_valid(reranker_target)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS semantic_model_catalog (
        id TEXT PRIMARY KEY,
        capability TEXT NOT NULL CHECK (capability IN ('embedding', 'rerank')),
        source TEXT NOT NULL CHECK (source IN ('default', 'detected', 'custom')),
        provider_id TEXT,
        model_id TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
        dimension INTEGER CHECK (dimension IS NULL OR dimension > 0),
        status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ready', 'error')),
        last_probe_at TEXT,
        last_probe_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_models_capability
        ON semantic_model_catalog(capability, source, status);

      CREATE TABLE IF NOT EXISTS semantic_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL CHECK (purpose IN ('code', 'docs', 'memory')),
        fingerprint TEXT NOT NULL,
        embedding_target TEXT NOT NULL CHECK (json_valid(embedding_target)),
        dimension INTEGER NOT NULL CHECK (dimension > 0),
        status TEXT NOT NULL DEFAULT 'building'
          CHECK (status IN ('building', 'ready', 'failed', 'retired')),
        expected_items INTEGER NOT NULL DEFAULT 0 CHECK (expected_items >= 0),
        indexed_items INTEGER NOT NULL DEFAULT 0 CHECK (indexed_items >= 0),
        failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_generations_status
        ON semantic_generations(purpose, status, id DESC);
      CREATE INDEX IF NOT EXISTS idx_semantic_generations_fingerprint
        ON semantic_generations(purpose, fingerprint, id DESC);

      CREATE TABLE IF NOT EXISTS semantic_namespace_generations (
        namespace TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('code', 'docs', 'memory')),
        active_generation_id INTEGER REFERENCES semantic_generations(id) ON DELETE SET NULL,
        building_generation_id INTEGER REFERENCES semantic_generations(id) ON DELETE SET NULL,
        expected_items INTEGER NOT NULL DEFAULT 0 CHECK (expected_items >= 0),
        indexed_items INTEGER NOT NULL DEFAULT 0 CHECK (indexed_items >= 0),
        failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
        delta_items INTEGER NOT NULL DEFAULT 0 CHECK (delta_items >= 0),
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (active_generation_id IS NULL OR active_generation_id != building_generation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_namespace_purpose
        ON semantic_namespace_generations(purpose, updated_at DESC);

      CREATE TABLE IF NOT EXISTS semantic_items (
        generation_id INTEGER NOT NULL REFERENCES semantic_generations(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        item_key TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        vector_id TEXT,
        chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (chunk_index >= 0),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'indexed', 'failed', 'stale')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (generation_id, namespace, item_key, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_items_work
        ON semantic_items(generation_id, namespace, status, attempts);
      CREATE INDEX IF NOT EXISTS idx_semantic_items_vector
        ON semantic_items(generation_id, namespace, vector_id);

      CREATE TABLE IF NOT EXISTS semantic_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_id INTEGER REFERENCES semantic_generations(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('build', 'backfill', 'delta', 'cleanup')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        cursor TEXT CHECK (cursor IS NULL OR json_valid(cursor)),
        expected_items INTEGER NOT NULL DEFAULT 0 CHECK (expected_items >= 0),
        processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
        failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_jobs_queue
        ON semantic_jobs(status, priority DESC, id);
      CREATE INDEX IF NOT EXISTS idx_semantic_jobs_namespace
        ON semantic_jobs(namespace, status, id DESC);

    `);

    // Old inference/vector configuration must stop being discoverable. This
    // removes only local config rows; no external service or index is deleted.
    // Guards keep the migration independently testable and safe for databases
    // imported from builds where one of the legacy tables never existed.
    for (const table of ['vector_store_configs', 'embedding_configs', 'reranker_configs']) {
      if (tableExists(db, table)) db.prepare(`DELETE FROM ${table}`).run();
    }

    const seedProfile = db.prepare(`
      INSERT OR IGNORE INTO semantic_profiles (purpose, embedding_target, reranker_target)
      VALUES (?, ?, ?)
    `);
    seedProfile.run('code', DEFAULT_EMBEDDING, DEFAULT_RERANKER);
    seedProfile.run('docs', DEFAULT_EMBEDDING, DEFAULT_RERANKER);
    seedProfile.run('memory', DEFAULT_EMBEDDING, DEFAULT_RERANKER);

    const seedModel = db.prepare(`
      INSERT OR IGNORE INTO semantic_model_catalog
        (id, capability, source, model_id, config, status)
      VALUES (?, ?, 'default', ?, ?, 'unknown')
    `);
    seedModel.run(
      'onnx:Xenova/multilingual-e5-small',
      'embedding',
      'Xenova/multilingual-e5-small',
      DEFAULT_EMBEDDING,
    );
    seedModel.run(
      'onnx:rerank:auto',
      'rerank',
      'auto',
      DEFAULT_RERANKER,
    );
  },
};
