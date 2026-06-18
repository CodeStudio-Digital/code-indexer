/**
 * Schema bootstrap for a per-project DB.
 *
 * P0 strategy (de-risked): a project DB reuses the SAME schema as the central
 * DB — `initSchema` + the central migration lineage. Both DBs therefore carry
 * the full schema; the ROUTING layer decides which file a given table's rows
 * are written to. This avoids hand-authoring a separate baseline that could
 * drift from the real schema. Trimming the project DB to project-only tables
 * (and the central DB to central-only tables) is a later, separately-shipped
 * cleanup (see plan §6.6 / P3-P6) — when it lands, only THIS file changes to
 * point at a dedicated project-migration lineage.
 *
 * Safe on a fresh empty file: it is exactly what a brand-new central install
 * runs, so every migration is already proven to apply to an empty DB.
 */
import type { DB } from '../db/types.js';
import { initSchema } from '../db/schema/index.js';
import { runMigrations, getSchemaVersion } from '../migrations/index.js';

export function initProjectSchema(db: DB): void {
  initSchema(db);
  runMigrations(db);
}

export function getProjectSchemaVersion(db: DB): number {
  return getSchemaVersion(db);
}
