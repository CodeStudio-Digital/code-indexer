/**
 * Migration 182 — `project_runtime_config.wsl_runtime_versions`.
 *
 * Per-project, per-WSL-distro runtime selection for the WSL runtime manager:
 * JSON `{"Ubuntu":{"node":"managed:20.11.0","python":"managed:3.12.3"}}`. The
 * runtimes are MCP-managed Linux builds installed INSIDE the distro under
 * `~/.mcp/runtimes`; this selection drives the per-terminal PATH injection for
 * a WSL shell. Distinct from `runtime_versions` (the Windows-side selection).
 *
 * Lives in the routed `project_runtime_config` table (migration 168) so it
 * travels with the project folder. Read/write is transparent: getProject
 * overlays it and updateProject routes writes here, alongside the other runtime
 * fields. NO central `projects` column — it MUST be destructured out in
 * updateProject (like package_managers).
 *
 * Forward-idempotent + zero-impact: column added only if missing. Runs on the
 * central DB and (via the shared schema lineage) on every per-project DB.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectWslRuntimeVersions182: Migration = {
  version: 182,
  name: 'project_wsl_runtime_versions',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'project_runtime_config', 'wsl_runtime_versions', 'TEXT');
  },
};
