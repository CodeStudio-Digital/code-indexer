/**
 * Migration 168 — `project_runtime_config` (per-project runtime/shell config).
 *
 * Moves the per-project runtime selection (node_version, runtime_versions,
 * runner_shell) out of the CENTRAL `projects` columns into a dedicated table
 * that the db-split routes into the project's own `.mcp-indexer/index.db`, so
 * the config travels with the project folder. Registered in db-split's
 * FEATURE_TABLES (copied on split, kept by trim).
 *
 * Read/write is transparent: CodeIndexDB.getProject overlays these 3 fields
 * from here (routed handle, central fallback) and updateProject routes writes
 * here. The legacy `projects.{node_version,runtime_versions,runner_shell}`
 * columns stay as a read fallback for DBs split BEFORE this migration; they're
 * backfilled here so nothing is lost.
 *
 * Idempotent: CREATE IF NOT EXISTS + INSERT OR IGNORE. Runs on the central DB
 * and (via the shared schema lineage) on every per-project DB when opened.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectRuntimeConfig168: Migration = {
  version: 168,
  name: 'project_runtime_config',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_runtime_config (
        project_id        INTEGER PRIMARY KEY,
        node_version      TEXT,
        runtime_versions  TEXT,
        runner_shell      TEXT
      );
    `);
    // Backfill from the legacy central columns — only rows that actually carry
    // a value (avoids creating empty rows for every project).
    db.exec(`
      INSERT OR IGNORE INTO project_runtime_config (project_id, node_version, runtime_versions, runner_shell)
      SELECT id, node_version, runtime_versions, runner_shell
        FROM projects
       WHERE node_version IS NOT NULL OR runtime_versions IS NOT NULL OR runner_shell IS NOT NULL;
    `);
  },
};
