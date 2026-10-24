/**
 * Migration 158 — group api_requests into folders.
 *
 * A single `folder` label per request (e.g. an OpenAPI tag, or the first path
 * segment). Nullable; null/'' = top level. This mirrors how Postman groups an
 * imported OpenAPI spec into folders by tag, without a separate nested-folders
 * table — enough for one level of grouping in the sidebar + Postman export.
 *
 * Guarded ADD COLUMN (PRAGMA table_info) so re-running is a no-op.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const apiRequestFolder158: Migration = {
  version: 158,
  name: 'api_request_folder',
  up: (db: DB): void => {
    const cols = (db.prepare('PRAGMA table_info(api_requests)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('folder')) db.exec('ALTER TABLE api_requests ADD COLUMN folder TEXT;');
  },
};
