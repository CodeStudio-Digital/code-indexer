/**
 * Migration 238 — split the oversized `knowledge` rollout domain into
 * independent `docs` and `memory` domains.
 *
 * Relational documentation/memory sources and FTS stay intact. Old Knowledge
 * vectors are deliberately not copied because a partially activated rollout
 * cannot prove one immutable vector space for every namespace. Code
 * generations are preserved byte-for-byte; docs and memory start without an
 * active generation and can rebuild independently.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const DEFAULT_EMBEDDING = JSON.stringify({
  kind: 'onnx', model: 'Xenova/multilingual-e5-small', dtype: 'q8',
  pooling: 'mean', normalize: true,
  queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}', maxTokens: 512,
});
const DEFAULT_RERANKER = JSON.stringify({
  kind: 'onnx', model: 'auto', dtype: 'q8', maxTokens: 512,
});

function tableExists(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function isTrimmedProjectDb(db: DB): boolean {
  if (!tableExists(db, 'project_db_meta')) return false;
  return !!db.prepare("SELECT 1 FROM project_db_meta WHERE key='trim_version'").get();
}

export const splitSemanticKnowledge238: Migration = {
  version: 238,
  name: 'split_semantic_knowledge',
  outsideTransaction: true,
  up(db: DB): void {
    if (isTrimmedProjectDb(db) || !tableExists(db, 'semantic_profiles')) return;
    const profileSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='semantic_profiles'",
    ).get() as { sql?: string } | undefined)?.sql ?? '';

    // Fresh databases already use the split schema from migration 227.
    if (profileSql.includes("'docs'") && profileSql.includes("'memory'")) return;

    const legacy = db.prepare(
      "SELECT embedding_target, reranker_target FROM semantic_profiles WHERE purpose='knowledge'",
    ).get() as { embedding_target: string; reranker_target: string } | undefined;
    const code = db.prepare(
      "SELECT embedding_target, reranker_target FROM semantic_profiles WHERE purpose='code'",
    ).get() as { embedding_target: string; reranker_target: string } | undefined;
    const inherited = legacy ?? code ?? {
      embedding_target: DEFAULT_EMBEDDING,
      reranker_target: DEFAULT_RERANKER,
    };

    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        // Remove only the obsolete vector control plane. Source rows, FTS and
        // the physical SQLite files remain available for explicit cleanup.
        db.exec(`
          DELETE FROM semantic_items
           WHERE generation_id IN (SELECT id FROM semantic_generations WHERE purpose='knowledge');
          DELETE FROM semantic_jobs
           WHERE generation_id IN (SELECT id FROM semantic_generations WHERE purpose='knowledge')
              OR namespace LIKE 'docs:c%'
              OR namespace LIKE 'snapshot:p%'
              OR namespace LIKE 'memory:%'
              OR namespace='semantic:reindex:knowledge';

          CREATE TABLE semantic_profiles_new (
            purpose TEXT PRIMARY KEY CHECK (purpose IN ('code', 'docs', 'memory')),
            embedding_target TEXT NOT NULL CHECK (json_valid(embedding_target)),
            reranker_target TEXT NOT NULL CHECK (json_valid(reranker_target)),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO semantic_profiles_new
            SELECT * FROM semantic_profiles WHERE purpose='code';

          CREATE TABLE semantic_generations_new (
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
          INSERT INTO semantic_generations_new
            SELECT * FROM semantic_generations WHERE purpose='code';

          CREATE TABLE semantic_namespace_generations_new (
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
          INSERT INTO semantic_namespace_generations_new
            SELECT * FROM semantic_namespace_generations WHERE purpose='code';

          DROP TABLE semantic_namespace_generations;
          DROP TABLE semantic_generations;
          DROP TABLE semantic_profiles;
          ALTER TABLE semantic_profiles_new RENAME TO semantic_profiles;
          ALTER TABLE semantic_generations_new RENAME TO semantic_generations;
          ALTER TABLE semantic_namespace_generations_new RENAME TO semantic_namespace_generations;

          CREATE INDEX idx_semantic_generations_status
            ON semantic_generations(purpose, status, id DESC);
          CREATE INDEX idx_semantic_generations_fingerprint
            ON semantic_generations(purpose, fingerprint, id DESC);
          CREATE INDEX idx_semantic_namespace_purpose
            ON semantic_namespace_generations(purpose, updated_at DESC);
        `);

        const insertProfile = db.prepare(`
          INSERT INTO semantic_profiles (purpose, embedding_target, reranker_target)
          VALUES (?, ?, ?)
        `);
        if (!db.prepare("SELECT 1 FROM semantic_profiles WHERE purpose='code'").get()) {
          insertProfile.run('code', DEFAULT_EMBEDDING, DEFAULT_RERANKER);
        }
        insertProfile.run('docs', inherited.embedding_target, inherited.reranker_target);
        insertProfile.run('memory', inherited.embedding_target, inherited.reranker_target);

        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`foreign_key_check found ${violations.length} violation(s)`);
        }
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  },
};
