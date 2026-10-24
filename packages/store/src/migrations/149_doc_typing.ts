/**
 * Migration 149 — documentation typing + section-level metadata.
 *
 * `doc_sources.doc_type` / `doc_chunks.doc_type`: the KIND of documentation
 * (api_reference | guide | conceptual | reference | changelog | handbook |
 * mixed). Chosen per-source in the "Documentação" Add Source dialog and
 * carried onto each chunk (denormalized) so retrieval can format/filter
 * without a JOIN. Default 'mixed' so existing sources keep working and
 * nothing is forced into the API-reference bucket. Vocabulary lives in
 * packages/store/src/doc/doc-type.ts.
 *
 * `doc_chunks.anchor`: heading-level URL fragment captured at crawl time so
 * citations can deep-link to the exact section (`source_uri#anchor`) instead
 * of the whole page. (Population lands with the anchor-extraction work; the
 * column is added here so the schema is ready.)
 *
 * `doc_chunks.api_symbol` / `api_signature`: extracted for api_reference
 * sections whose heading reads like a signature (`Class.method(args)`), so an
 * agent can ground code against exact API shapes.
 *
 * All columns are additive + nullable (or defaulted) → no backfill. Existing
 * chunks read as untyped/unanchored until the source is re-indexed.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const docTyping149: Migration = {
  version: 149,
  name: 'doc_typing',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'doc_sources', 'doc_type', "TEXT NOT NULL DEFAULT 'mixed'");
    addColumnIfMissing(db, 'doc_chunks', 'doc_type', 'TEXT');
    addColumnIfMissing(db, 'doc_chunks', 'anchor', 'TEXT');
    addColumnIfMissing(db, 'doc_chunks', 'api_symbol', 'TEXT');
    addColumnIfMissing(db, 'doc_chunks', 'api_signature', 'TEXT');
  },
};
