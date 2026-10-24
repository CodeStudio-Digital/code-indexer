/**
 * Migration 071 — Persist auto-mapper tier on each file row.
 *
 * The mapper at `core/indexer/mapper.ts` already classifies files into
 * `core` / `support` / `on_demand` / `excluded` during scanning, but the
 * tier was being thrown away after we decided whether to skip a file.
 * Storing it lets the indexer's embedding step skip `on_demand` files
 * (tests, docs, migrations) when running under the aggressive profile,
 * and unlocks the cost-by-tier breakdown the Hygiene panel needs.
 *
 * `mapper_reason` is the short string explaining the decision so the
 * dashboard can show *why* a file was demoted (e.g. "tests/docs/migrations"
 * vs "matches entrypoint pattern"). Backfill is not required — files
 * keep `NULL` until their next reindex updates them.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const fileIndexTier071: Migration = {
  version: 71,
  name: 'file_index_tier',
  up: (db: DB): void => {
    const cols = db
      .prepare("PRAGMA table_info(files)")
      .all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));

    if (!have.has('index_tier')) {
      db.exec(`ALTER TABLE files ADD COLUMN index_tier TEXT;`);
    }
    if (!have.has('mapper_reason')) {
      db.exec(`ALTER TABLE files ADD COLUMN mapper_reason TEXT;`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_tier
        ON files(project_id, index_tier);
    `);
  },
};
