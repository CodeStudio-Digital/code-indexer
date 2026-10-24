/**
 * Migration 244 — direct semantic-item identity lookup.
 *
 * Source-health queries correlate every documentation chunk with its accepted
 * semantic item. The generic work-queue index starts with status and made
 * SQLite scan an entire generation once per chunk on large corpora. This
 * covering identity index turns that join into one bounded lookup per chunk.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const semanticItemsIdentityLookup244: Migration = {
  version: 244,
  name: 'semantic_items_identity_lookup',
  up(db: DB): void {
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='semantic_items'",
    ).get();
    if (!table) return;

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_items_identity
        ON semantic_items(generation_id, namespace, item_key, status, vector_id)
    `);
  },
};
