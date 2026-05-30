/**
 * Per-plugin key-value storage (namespace + key composite PK). Backs the
 * `ctx.storage` capability and the UI `plugins.storage*` methods. Values are
 * opaque strings; the plugin JSON-encodes structured data itself. Follows the
 * same connection conventions as InstalledPluginStore. `deleteNamespace` is
 * the uninstall teardown.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class PluginStorageStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrInstance: string | DB) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  get(namespace: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM plugin_storage WHERE namespace = ? AND key = ?')
      .get(namespace, key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  set(namespace: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO plugin_storage (namespace, key, value, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(namespace, key, value);
  }

  delete(namespace: string, key: string): void {
    this.db
      .prepare('DELETE FROM plugin_storage WHERE namespace = ? AND key = ?')
      .run(namespace, key);
  }

  listKeys(namespace: string): string[] {
    const rows = this.db
      .prepare('SELECT key FROM plugin_storage WHERE namespace = ? ORDER BY key')
      .all(namespace) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  /** Drop every row for a plugin — called on uninstall. */
  deleteNamespace(namespace: string): void {
    this.db.prepare('DELETE FROM plugin_storage WHERE namespace = ?').run(namespace);
  }
}
