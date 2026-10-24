/**
 * Migration 228 — historical binding of investigation vectors to their embedding
 * model/backend/template. Legacy vectors remain NULL and are intentionally
 * excluded from semantic recall until recaptured/re-embedded. Migration 229
 * removes both vector columns and rebuilds from relational text under the
 * distributed Knowledge profile.
 *
 * `coder_investigations` is central-only and is removed from project DBs by
 * the trim step, so every statement must be guarded.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table);
}

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

export const investigationEmbeddingFingerprint228: Migration = {
  version: 228,
  name: 'investigation_embedding_fingerprint',
  up: (db: DB): void => {
    if (!tableExists(db, 'coder_investigations')) return;
    if (!hasColumn(db, 'coder_investigations', 'embedding_fingerprint')) {
      db.exec(`ALTER TABLE coder_investigations ADD COLUMN embedding_fingerprint TEXT;`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_investigations_embedding_fingerprint
      ON coder_investigations(embedding_fingerprint)
      WHERE embedding IS NOT NULL;
    `);
  },
};
