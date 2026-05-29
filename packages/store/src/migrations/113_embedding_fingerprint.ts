/**
 * Migration 113 — per-project embedding fingerprint.
 *
 * Records which embedding model/backend a project's vectors were last built
 * with (e.g. `local:Xenova/multilingual-e5-small`, `cloudflare:bge-m3`). When
 * the active embedding changes, the indexer compares this against the live
 * fingerprint and clears embedding hashes so everything re-embeds under the
 * new model — without this, the incremental hash check would skip re-embedding
 * and leave the new vector store empty (or dimension-mismatched).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const embeddingFingerprint113: Migration = {
  version: 113,
  name: 'embedding_fingerprint',
  up: (db: DB): void => {
    const cols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'embedding_fingerprint')) {
      db.exec(`ALTER TABLE projects ADD COLUMN embedding_fingerprint TEXT`);
    }
  },
};
