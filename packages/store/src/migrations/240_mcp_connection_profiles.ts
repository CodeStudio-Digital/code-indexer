import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasTable(db: DB, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

/** Persistent policy profiles and asynchronous MCP-owned agent runs. */
export const mcpConnectionProfiles240: Migration = {
  version: 240,
  name: 'mcp_connection_profiles',
  up(db: DB): void {
    // API-token tables only exist in the main application database. Project
    // databases intentionally skip this control-plane schema.
    if (!hasTable(db, 'api_tokens')) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_connection_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        project_ids TEXT NOT NULL DEFAULT '[]',
        tool_allowlist TEXT NOT NULL DEFAULT '[]',
        agent_allowlist TEXT NOT NULL DEFAULT '[]',
        approval_mode TEXT NOT NULL DEFAULT 'controlled'
          CHECK (approval_mode IN ('read_only', 'controlled', 'admin')),
        max_concurrent_runs INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent_runs BETWEEN 1 AND 16),
        max_runtime_ms INTEGER NOT NULL DEFAULT 1800000 CHECK (max_runtime_ms BETWEEN 1000 AND 86400000),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_agent_runs (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        profile_id TEXT REFERENCES mcp_connection_profiles(id) ON DELETE SET NULL,
        session_id INTEGER,
        project_id INTEGER,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        task_preview TEXT NOT NULL DEFAULT '',
        final_text TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_agent_runs_owner_status
        ON mcp_agent_runs(principal, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_agent_runs_profile_status
        ON mcp_agent_runs(profile_id, status, created_at DESC);
    `);

    if (!hasColumn(db, 'api_tokens', 'profile_id')) {
      db.exec(
        'ALTER TABLE api_tokens ADD COLUMN profile_id TEXT REFERENCES mcp_connection_profiles(id) ON DELETE SET NULL',
      );
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_api_tokens_profile_id ON api_tokens(profile_id)');
  },
};
