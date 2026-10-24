/**
 * Migration 112 — Installed plugins registry.
 *
 * One row per installed plugin namespace. The plugin installer writes here
 * after applying a plugin's skills / MCP servers / UI contributions, and
 * uninstall removes the row. JSON columns snapshot the plugin.json
 * (`manifest`), the .app.json contributions (`contributions`), and the
 * install source so the IDE can list/render installed plugins and rehydrate
 * UI + agent-tool contributions without re-reading disk.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const installedPlugins112: Migration = {
  version: 112,
  name: 'installed_plugins',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS installed_plugins (
        namespace TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT,
        manifest TEXT,
        contributions TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        signature TEXT,
        installed_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_installed_plugins_enabled
        ON installed_plugins(enabled);
    `);
  },
};
