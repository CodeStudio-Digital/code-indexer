/**
 * Migration 096 — Auto-discovery suggestions for doc collections.
 *
 * Hybrid ingestion model: manual indexing via the dashboard continues to
 * work as before. In addition, the `AutoDiscoveryService` periodically
 * scans the project's dependency manifests (package.json, requirements.txt,
 * pyproject.toml, Cargo.toml, go.mod, composer.json, Gemfile), resolves
 * canonical docs URLs via registry APIs (npm, pypi, crates.io, pkg.go.dev,
 * packagist, rubygems), and persists suggestions here for the user to
 * approve or dismiss from the dashboard.
 *
 * Suggestions are NOT auto-indexed — approval is explicit. Once approved,
 * `indexed_source_id` is set to the resulting `doc_sources.id` so the row
 * can be deduped against future scans.
 *
 * Anti-duplication: `(project_id, package_manager, package_name)` is
 * UNIQUE. A re-scan that detects the same package as a previously
 * dismissed/approved suggestion is a no-op (`INSERT OR IGNORE`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docSourceSuggestions096: Migration = {
  version: 96,
  name: 'doc_source_suggestions',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_source_suggestions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        package_manager     TEXT NOT NULL CHECK(package_manager IN
                              ('npm','pypi','cargo','go','composer','rubygems')),
        package_name        TEXT NOT NULL,
        package_version     TEXT,
        suggested_url       TEXT NOT NULL,
        suggested_title     TEXT,
        confidence          REAL NOT NULL DEFAULT 0.5,
        status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending','approved','dismissed','indexed')),
        discovered_at       TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at          TEXT,
        indexed_source_id   INTEGER REFERENCES doc_sources(id) ON DELETE SET NULL,
        UNIQUE(project_id, package_manager, package_name)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_source_suggestions_project_status
        ON doc_source_suggestions(project_id, status);

      CREATE INDEX IF NOT EXISTS idx_doc_source_suggestions_pending
        ON doc_source_suggestions(status, discovered_at)
        WHERE status = 'pending';
    `);
  },
};
