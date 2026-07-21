import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { semanticItemsIdentityLookup244 } from '../244_semantic_items_identity_lookup.js';

describe('migration 244 - semantic item identity lookup', () => {
  it('creates the covering lookup index idempotently', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE semantic_items (
        generation_id INTEGER NOT NULL,
        namespace TEXT NOT NULL,
        item_key TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        vector_id TEXT,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (generation_id, namespace, item_key, chunk_index)
      )
    `);

    semanticItemsIdentityLookup244.up(db);
    semanticItemsIdentityLookup244.up(db);

    const columns = db.prepare("PRAGMA index_info('idx_semantic_items_identity')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'generation_id',
      'namespace',
      'item_key',
      'status',
      'vector_id',
    ]);
    db.close();
  });

  it('is a no-op in trimmed databases without semantic_items', () => {
    const db = new Database(':memory:');
    expect(() => semanticItemsIdentityLookup244.up(db)).not.toThrow();
    db.close();
  });
});
