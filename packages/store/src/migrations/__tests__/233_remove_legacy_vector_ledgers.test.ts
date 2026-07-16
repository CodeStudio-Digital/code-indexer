import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { removeLegacyVectorLedgers233 } from '../233_remove_legacy_vector_ledgers.js';

describe('migration 233 — remove legacy vector ledgers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE vector_ids (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        vector_id TEXT NOT NULL
      );
      CREATE TABLE doc_chunk_vectors (
        id INTEGER PRIMARY KEY,
        chunk_id INTEGER NOT NULL,
        vector_id TEXT NOT NULL
      );
      CREATE TABLE pending_vector_deletes (id INTEGER PRIMARY KEY, vector_id TEXT NOT NULL);
      CREATE TABLE doc_vector_tombstones (id INTEGER PRIMARY KEY, vector_id TEXT NOT NULL);
      CREATE TABLE embedding_configs (id TEXT PRIMARY KEY);
      CREATE TABLE vector_store_configs (id TEXT PRIMARY KEY);
      CREATE TABLE reranker_configs (id TEXT PRIMARY KEY);
      CREATE TABLE embedding_store_configs (id TEXT PRIMARY KEY);
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        pending_vector_gc INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE semantic_items (
        generation_id INTEGER NOT NULL,
        namespace TEXT NOT NULL,
        item_key TEXT NOT NULL,
        vector_id TEXT,
        PRIMARY KEY (generation_id, namespace, item_key)
      );
      INSERT INTO semantic_items VALUES (2, 'code:p7', 'file:src/a.ts', 'v-1');
    `);
  });

  afterEach(() => db.close());

  it('drops mirrors and the remote retry queue idempotently while preserving semantic_items', () => {
    removeLegacyVectorLedgers233.up(db);
    removeLegacyVectorLedgers233.up(db);

    const names = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'vector_ids', 'doc_chunk_vectors', 'pending_vector_deletes', 'doc_vector_tombstones',
        'embedding_configs', 'vector_store_configs', 'reranker_configs', 'embedding_store_configs'
      )
    `).all();
    expect(names).toEqual([]);
    expect(db.prepare('SELECT vector_id FROM semantic_items').get())
      .toEqual({ vector_id: 'v-1' });
    expect((db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>)
      .map((column) => column.name)).toEqual(['id', 'name']);
  });
});
