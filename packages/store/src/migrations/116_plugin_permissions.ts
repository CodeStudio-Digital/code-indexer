/**
 * Migration 116 — add permissions_granted to installed_plugins.
 *
 * JSON blob of the capability subset the user approved at install
 * (fs/exec/storage). NULL = nothing granted yet. The host re-checks this on
 * every ctx.fs / ctx.exec / ctx.storage call (defense in depth).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const pluginPermissions116: Migration = {
  version: 116,
  name: 'plugin_permissions',
  up: (db: DB): void => {
    const cols = db
      .prepare(`PRAGMA table_info(installed_plugins)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'permissions_granted')) {
      db.exec(`ALTER TABLE installed_plugins ADD COLUMN permissions_granted TEXT;`);
    }
  },
};
