/**
 * Schema migration runner.
 *
 * Migrations are versioned SQL changes applied in order. Each migration runs
 * exactly once per database. The current version is tracked in the
 * `schema_version` table.
 *
 * Convention:
 *   - File name: NNN_description.ts (e.g. 001_baseline.ts)
 *   - Export: { version: number, name: string, up(db): void }
 *
 * To add a migration:
 *   1. Create a new file `NNN_description.ts` with the next version number.
 *   2. Import it here and add it to the MIGRATIONS array in order.
 *   3. Migrations are idempotent at the runner level — already-applied
 *      migrations are skipped.
 */
import type DatabaseConstructor from 'better-sqlite3';
import { baseline001 } from './001_baseline.js';
import { symbolStableId002 } from './002_symbol_stable_id.js';
import { snapshotFiles003 } from './003_snapshot_files.js';
import { coderSessions004 } from './004_coder_sessions.js';
import { coderCacheTokens005 } from './005_coder_cache_tokens.js';
import { adminProviders006 } from './006_admin_providers.js';
import { coderPlans007 } from './007_coder_plans.js';
import { coderTasks008 } from './008_coder_tasks.js';
import { sessionsArchiveAndGroups009 } from './009_sessions_archive_and_groups.js';
import { sessionFavorites010 } from './010_session_favorites.js';
import { vectorStoreConfigs011 } from './011_vector_store_configs.js';
import { embeddingHash012 } from './012_embedding_hash.js';
import { coderTodosAndWorktree013 } from './013_coder_todos_and_worktree.js';
import { toolConfigs014 } from './014_tool_configs.js';
import { mcpServers015 } from './015_mcp_servers.js';
import { skills016 } from './016_skills.js';
import { mcpServerTools017 } from './017_mcp_server_tools.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

export const MIGRATIONS: Migration[] = [
  baseline001,
  symbolStableId002,
  snapshotFiles003,
  coderSessions004,
  coderCacheTokens005,
  adminProviders006,
  coderPlans007,
  coderTasks008,
  sessionsArchiveAndGroups009,
  sessionFavorites010,
  vectorStoreConfigs011,
  embeddingHash012,
  coderTodosAndWorktree013,
  toolConfigs014,
  mcpServers015,
  skills016,
  mcpServerTools017,
];

/**
 * Ensure the `schema_version` table exists and apply any pending migrations.
 * Safe to call on both fresh and existing databases.
 */
export function runMigrations(db: DB): { applied: number[]; current: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all() as { version: number }[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const applied: number[] = [];
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const migration of sorted) {
    if (appliedSet.has(migration.version)) continue;

    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      );
    });

    try {
      tx();
      applied.push(migration.version);
    } catch (e) {
      const err = e as Error;
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${err.message}`
      );
    }
  }

  const currentRow = db
    .prepare('SELECT MAX(version) as v FROM schema_version')
    .get() as { v: number | null };
  return { applied, current: currentRow.v ?? 0 };
}

/**
 * Return the current schema version, or 0 if migrations have not run yet.
 */
export function getSchemaVersion(db: DB): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number | null };
    return row.v ?? 0;
  } catch {
    return 0;
  }
}
