/**
 * Migration 127 — historical embedding column for the investigation ledger.
 *
 * Stores a bge-m3 (or configured embedder) vector for each investigation
 * digest as a BLOB (Float32Array bytes), enabling semantic `recall_investigations`
 * via brute-force cosine instead of keyword LIKE. NULL until the background
 * embed (fire-and-forget at record time) lands; recall falls back to keyword
 * when an investigation has no embedding or no embedder is available.
 * Migration 229 later removes this central BLOB without copying it; the
 * runtime now rebuilds investigation vectors in each project's vectors.db.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const investigationEmbedding127: Migration = {
  version: 127,
  name: 'investigation_embedding',
  up: (db: DB): void => {
    db.exec(`ALTER TABLE coder_investigations ADD COLUMN embedding BLOB;`);
  },
};
