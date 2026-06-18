/**
 * Migration 159 — explicit folder list per collection.
 *
 * Requests carry a `folder` label (mig 158), but that means a folder only exists
 * while it has ≥1 request. To let the user CREATE an empty folder in the IDE and
 * have it persist (Postman-style), the collection keeps an explicit ordered list
 * of folder names in `folders_json`. The sidebar shows the union of this list and
 * the distinct folders actually used by requests.
 *
 * Guarded ADD COLUMN so re-running is a no-op.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const apiCollectionFolders159: Migration = {
  version: 159,
  name: 'api_collection_folders',
  up: (db: DB): void => {
    const cols = (db.prepare('PRAGMA table_info(api_collections)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('folders_json')) db.exec("ALTER TABLE api_collections ADD COLUMN folders_json TEXT DEFAULT '[]';");
  },
};
