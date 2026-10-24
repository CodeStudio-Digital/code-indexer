/**
 * Migration 171 — documentation fields for the API client (Docs Studio).
 *
 * Per-endpoint + collection-level documentation so a collection can be authored
 * into a real doc site (overview, per-endpoint markdown, per-param docs, folder
 * descriptions, branding). All additive, guarded ADD COLUMN (PRAGMA table_info)
 * so re-running is a no-op — mirrors apiRequestFolder158.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
}

export const apiDocFields171: Migration = {
  version: 171,
  name: 'api_doc_fields',
  up: (db: DB): void => {
    // Per-endpoint docs.
    addColumn(db, 'api_requests', 'description', 'description TEXT');
    addColumn(db, 'api_requests', 'param_docs_json', 'param_docs_json TEXT'); // { "query:limit": "markdown", ... }
    // Collection-level doc surface.
    addColumn(db, 'api_collections', 'overview_md', 'overview_md TEXT');
    addColumn(db, 'api_collections', 'branding_json', 'branding_json TEXT'); // { name, logoDataUri, accent, faviconDataUri, links }
    addColumn(db, 'api_collections', 'folder_docs_json', 'folder_docs_json TEXT'); // { [folderName]: markdown }
  },
};
