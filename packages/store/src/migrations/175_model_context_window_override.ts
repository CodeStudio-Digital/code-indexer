/**
 * Migration 175 — Sticky admin override for `provider_models.context_window`.
 *
 * Until now every live-discovery refresh (incl. the one that fires ~10s after
 * each app startup) overwrote `context_window` with the value discovery
 * supplies — for Z.AI/DeepSeek/Moonshot that's the static registry value
 * (`getRegistryContextWindow`), so a model the admin manually bumped (e.g.
 * `glm-5.2` → 1M) silently reverted to the registry default (200K) on the next
 * restart.
 *
 * `context_window_overridden` is the marker that the admin explicitly set the
 * window. `replaceFromSource` preserves `context_window` for flagged rows the
 * same way it already preserves `enabled` / `default_reasoning_level` /
 * `max_tools`. The PATCH route sets the flag (1 for a real value, 0 when the
 * admin clears the override → falls back to discovery again).
 *
 * Default 0 — NOT backfilled. Providers whose discovery returns a *real*
 * upstream window (OpenRouter, Gemini, Bedrock) must keep refreshing it, so we
 * can't blanket-freeze existing rows. The admin re-applies the override once
 * after upgrading; it then sticks forever.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  // `provider_models` ∈ CENTRAL_DROP_TABLES — a per-project DB runs this central
  // migration lineage but trims the table away (see project-db/trim/drop-list.ts).
  // On a project DB created under an older build (no mig 175 yet), the table is
  // already gone when this runs on upgrade, so guard or the ALTER throws
  // `no such table`. Mirrors the guarded helper in migration 065.
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const modelContextWindowOverride175: Migration = {
  version: 175,
  name: 'model_context_window_override',
  up: (db: DB): void => {
    addColumnIfMissing(
      db,
      'provider_models',
      'context_window_overridden',
      'INTEGER NOT NULL DEFAULT 0',
    );
  },
};
