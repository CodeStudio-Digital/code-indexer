/**
 * Migration 134 — `project_doc_collections` (N:M project ↔ doc collection).
 *
 * Doc collections are GLOBAL (migration 086) — fine for ingestion, but it
 * means `rag_search_docs` fans out over every collection regardless of the
 * project a session is working on (Unity hits while coding React). This
 * table scopes retrieval: a session's project resolves to its linked
 * collections and the search backend filters to that subset (falling back
 * to global when a project has no links).
 *
 * `origin` records HOW the link came to be: `'manual'` via the dashboard
 * (CollectionDetail → Projetos vinculados) and `'auto'` when approving a
 * doc-source suggestion auto-links the resulting collection to the
 * suggestion's project.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectDocCollections134: Migration = {
  version: 134,
  name: 'project_doc_collections',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_doc_collections (
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        collection_id INTEGER NOT NULL REFERENCES doc_collections(id) ON DELETE CASCADE,
        origin        TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'auto')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, collection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_project_doc_collections_collection
        ON project_doc_collections(collection_id);
    `);
  },
};
