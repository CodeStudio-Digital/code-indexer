/**
 * Migration 174 — embedded database client (DataGrip × phpMyAdmin), project-scoped.
 *
 *   - db_connections   → saved connections (engine/host/port/user/db, SSL, optional
 *                        SSH tunnel, color/group, read-only guard)
 *   - db_query_history → executed statements per connection (audit + re-run)
 *   - db_saved_queries → named, reusable queries
 *
 * Secrets (`enc_*` columns) are encrypted by the renderer with the OS keychain
 * (Electron `safeStorage`, via the shared `secrets:encrypt`/`secrets:decrypt` IPC)
 * before they reach the store, which persists only the opaque tagged blob:
 *   `enc:<b64>`   → keychain ciphertext (device-bound)
 *   `plain:<b64>` → obfuscated fallback when no OS keychain (rare bare Linux)
 *   `v1:<json>`   → @mcp/vault-crypto envelope (P3, passphrase vault) — same column
 * The server NEVER sees plaintext. All tables are project-scoped (the IDE mounts
 * connections inside the open project). Mirrors the SSH client (migration 173).
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS). FK cascade only fires when
 * PRAGMA foreign_keys is ON, so the store also deletes children explicitly.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const dbClient174: Migration = {
  version: 174,
  name: 'db_client',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS db_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        engine TEXT NOT NULL,                 -- 'postgres' | 'mysql' | 'mariadb' | 'sqlite' (later: mssql | mongodb | redis | oracle)
        host TEXT,
        port INTEGER,
        username TEXT,
        database_name TEXT,                   -- default db/schema to open
        file_path TEXT,                       -- sqlite only
        enc_password TEXT,                    -- opaque: enc:/plain: device-bound OR v1: vault envelope
        ssl_mode TEXT,                        -- 'disable' | 'require' | 'verify-ca' | 'verify-full'
        enc_ssl_ca TEXT,
        enc_ssl_cert TEXT,
        enc_ssl_key TEXT,
        ssh_tunnel_host_id INTEGER REFERENCES ssh_hosts(id) ON DELETE SET NULL,
        ssh_tunnel_json TEXT,                 -- inline tunnel spec when not pointing at a saved ssh_host
        options_json TEXT NOT NULL DEFAULT '{}',
        color TEXT,
        group_name TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_read_only INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_db_connections_project ON db_connections(project_id, sort_order);

      CREATE TABLE IF NOT EXISTS db_query_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        connection_id INTEGER REFERENCES db_connections(id) ON DELETE CASCADE,
        sql TEXT NOT NULL,
        database_name TEXT,
        duration_ms INTEGER,
        row_count INTEGER,
        status TEXT NOT NULL DEFAULT 'ok',    -- 'ok' | 'error' | 'cancelled'
        error_message TEXT,
        executed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_db_query_history_conn ON db_query_history(connection_id, executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_db_query_history_project ON db_query_history(project_id, executed_at DESC);

      CREATE TABLE IF NOT EXISTS db_saved_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        connection_id INTEGER REFERENCES db_connections(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        sql TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_db_saved_queries_project ON db_saved_queries(project_id, sort_order);
    `);
  },
};
