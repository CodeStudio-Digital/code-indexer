/**
 * Migration 001 — Baseline.
 *
 * Registers the schema as it existed before the migration runner was
 * introduced (v3.2 and earlier). The actual schema creation is still done
 * by `CodeIndexDB.initSchema()` via `CREATE TABLE IF NOT EXISTS`, so this
 * migration is a no-op on disk — it simply marks version 1 as applied.
 *
 * New databases: `initSchema()` runs first, then this migration marks v1.
 * Existing databases: tables already exist, migration marks v1 without changes.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const baseline001: Migration = {
  version: 1,
  name: 'baseline',
  up: (_db: DB): void => {
    // no-op: schema is bootstrapped by initSchema() using IF NOT EXISTS.
  },
};
