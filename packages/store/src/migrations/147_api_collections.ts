/**
 * Migration 147 — API client (in-app Postman) persistence.
 *
 * Four project-scoped tables backing the API tab + the auto-test/auto-fix
 * agent + the non-LLM regression runner:
 *   - api_collections     → a named group of requests, optionally imported
 *                            from an OpenAPI spec (spec_hash → idempotent
 *                            re-import).
 *   - api_environments    → per-project named env (base_url + variables);
 *                            variables_json holds `{ key: { value, secret } }`.
 *   - api_requests        → one HTTP request. Verification is folded in
 *                            (verified/expected_status/assert_json) so a
 *                            request row is self-contained.
 *   - api_regression_runs → one row per "Run all"; per-request outcomes live
 *                            in results_json (read whole, never queried).
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS) — mirrors builder_checkpoints144.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const apiCollections147: Migration = {
  version: 147,
  name: 'api_collections',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        spec_source TEXT,
        spec_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_collections_project
        ON api_collections(project_id, id DESC);

      CREATE TABLE IF NOT EXISTS api_environments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        variables_json TEXT NOT NULL DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_envs_project
        ON api_environments(project_id);

      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        path_template TEXT NOT NULL DEFAULT '',
        headers_json TEXT NOT NULL DEFAULT '{}',
        query_json TEXT NOT NULL DEFAULT '{}',
        body_json TEXT,
        body_kind TEXT NOT NULL DEFAULT 'none',
        verified INTEGER NOT NULL DEFAULT 0,
        expected_status INTEGER,
        assert_json TEXT,
        last_status INTEGER,
        last_run_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_requests_collection
        ON api_requests(collection_id, sort_order);

      CREATE TABLE IF NOT EXISTS api_regression_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
        env_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        total INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        results_json TEXT NOT NULL DEFAULT '[]',
        trigger TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_runs_collection
        ON api_regression_runs(collection_id, id DESC);
    `);
  },
};
