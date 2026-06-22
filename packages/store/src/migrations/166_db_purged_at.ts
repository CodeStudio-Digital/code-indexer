/**
 * Migration 166 — central-purge marker (C3).
 *
 * `db_purged_at` records when a project's INDEX rows were deleted from the
 * CENTRAL DB after its split was verified + soaked (served from its own DB
 * across ≥1 restart). Separate from `db_split_status` (which stays 'done' so the
 * routing predicate is unaffected) — the purge is an independent, deferred,
 * space-reclaiming pass gated behind MCP_DB_SPLIT_PURGE=immediate.
 *
 * Purely additive/idempotent; inert when the purge gate is off.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const dbPurgedAt166: Migration = {
  version: 166,
  name: 'db_purged_at',
  up: (db: DB): void => {
    const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'db_purged_at')) {
      db.exec(`ALTER TABLE projects ADD COLUMN db_purged_at TEXT`);
    }
  },
};
