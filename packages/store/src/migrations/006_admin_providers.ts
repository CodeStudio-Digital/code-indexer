/**
 * Migration 006 — Admin: providers, models, oauth tokens, embedding configs.
 *
 * Creates the persistent layer that lets the dashboard /admin UI CRUD providers,
 * API keys, discovered models, and pluggable embedding backends. Also adds a
 * `model_mode` column to coder_sessions so the coder agent can remember whether
 * a session was started in ZAI "normal" or "coding" mode.
 *
 * All tables are additive — nothing destructive. Safe on fresh and existing DBs.
 * Seed data (migrating env-var providers into provider_configs) is handled at
 * runtime by ProviderStore.seedFromEnvIfEmpty(), not here, so this migration
 * stays purely structural.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const adminProviders006: Migration = {
  version: 6,
  name: 'admin_providers',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_configs (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        base_url      TEXT,
        api_key       TEXT,
        auth_mode     TEXT NOT NULL DEFAULT 'api_key',
        enabled       INTEGER NOT NULL DEFAULT 1,
        use_for_agent INTEGER NOT NULL DEFAULT 1,
        use_for_coder INTEGER NOT NULL DEFAULT 1,
        is_default    INTEGER NOT NULL DEFAULT 0,
        extra         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_provider_configs_enabled
        ON provider_configs(enabled, use_for_coder, use_for_agent);

      CREATE TABLE IF NOT EXISTS provider_models (
        provider_id          TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id             TEXT NOT NULL,
        mode                 TEXT NOT NULL DEFAULT '',
        name                 TEXT NOT NULL,
        context_window       INTEGER,
        default_max_tokens   INTEGER,
        can_reason           INTEGER NOT NULL DEFAULT 0,
        supports_attachments INTEGER NOT NULL DEFAULT 0,
        enabled              INTEGER NOT NULL DEFAULT 1,
        source               TEXT NOT NULL DEFAULT 'manual',
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (provider_id, model_id, mode)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_models_provider
        ON provider_models(provider_id, enabled);

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider_id   TEXT PRIMARY KEY REFERENCES provider_configs(id) ON DELETE CASCADE,
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        expires_at    INTEGER,
        scope         TEXT,
        extra         TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS embedding_configs (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        config     TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Remember the ZAI mode (normal|coding) used when a coder session was
    // started. Default '' means "not applicable / provider doesn't distinguish".
    addColumnIfMissing(db, 'coder_sessions', 'model_mode', "TEXT NOT NULL DEFAULT ''");
  },
};
