/**
 * Migration 117 — per-plugin key-value storage.
 *
 * Backs the `ctx.storage` capability and the UI `plugins.storage*` methods.
 * Namespaced by plugin; values are opaque strings (the plugin JSON-encodes
 * structured data itself). Rows are dropped when the plugin is uninstalled.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const pluginStorage117: Migration = {
  version: 117,
  name: 'plugin_storage',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_storage (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (namespace, key)
      );
    `);
  },
};
