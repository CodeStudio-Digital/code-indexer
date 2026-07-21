import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { docChunksEnrichmentLookup245 } from '../245_doc_chunks_enrichment_lookup.js';

describe('migration 245 - documentation enrichment lookup', () => {
  it('indexes source and enrichment state together', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE doc_chunks (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL,
        enrichment_fingerprint TEXT
      )
    `);

    docChunksEnrichmentLookup245.up(db);
    docChunksEnrichmentLookup245.up(db);

    const columns = db.prepare("PRAGMA index_info('idx_doc_chunks_enrichment_fingerprint')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'source_id',
      'enrichment_fingerprint',
    ]);
    db.close();
  });

  it('is a no-op when the enrichment column is unavailable', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE doc_chunks (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL)');
    expect(() => docChunksEnrichmentLookup245.up(db)).not.toThrow();
    db.close();
  });
});
