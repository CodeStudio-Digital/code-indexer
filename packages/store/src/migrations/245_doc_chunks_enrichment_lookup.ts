/** Migration 245 — source-scoped enrichment health lookup. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docChunksEnrichmentLookup245: Migration = {
  version: 245,
  name: 'doc_chunks_enrichment_lookup',
  up(db: DB): void {
    const columns = db.prepare("PRAGMA table_info('doc_chunks')").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'enrichment_fingerprint')) return;

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_enrichment_fingerprint
        ON doc_chunks(source_id, enrichment_fingerprint)
    `);
  },
};
