/**
 * Migration 012 — Incremental embedding hashes.
 *
 * Adds `embedding_hash` columns to `files` and `symbols` so the indexer can
 * skip re-embedding unchanged content across runs. The hash is computed from
 * the exact text fed into the embedding service (signature + body for
 * symbols, summary + concepts for files), so any change to the source — or
 * to the embedding-text template — triggers a re-embed on the next index.
 *
 * Purely additive: existing rows get NULL and are treated as "embed on next
 * run". Safe on fresh and existing DBs.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const embeddingHash012: Migration = {
  version: 12,
  name: 'embedding_hash',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'files', 'embedding_hash', 'TEXT');
    addColumnIfMissing(db, 'symbols', 'embedding_hash', 'TEXT');
    addColumnIfMissing(db, 'symbols', 'body_embedding_hash', 'TEXT');
  },
};
