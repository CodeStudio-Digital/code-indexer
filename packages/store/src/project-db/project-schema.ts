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
 *
 * C2: after the full schema is built + verified, `trimProjectSchema` drops the
 * ~93 central-only tables this inherits and recreates the project tables that
 * carry a cross-DB FK without it — leaving a project-only DB. It is a no-op when
 * the trim flag is off (byte-identical to today) and is keyed off its own marker
 * (idempotent). This is the ONLY place trim runs, and it only ever sees a
 * per-project DB — the central DB opens via the CodeIndexDB constructor, never
 * here, so trim is structurally unreachable from the central path.
 */
import type { DB } from '../db/types.js';
import { initSchema } from '../db/schema/index.js';
import { MIGRATIONS, runMigrations, getSchemaVersion } from '../migrations/index.js';
import { isProjectSchemaTrimCurrent, trimProjectSchema } from './trim/index.js';
import { assertSessionScopedSqliteAbsent } from '../session-layout-guard.js';

export function initProjectSchema(db: DB): void {
  const latestVersion = MIGRATIONS.reduce(
    (latest, migration) => Math.max(latest, migration.version),
    0,
  );
  // A global-only update must not bootstrap/drop the central schema in every
  // project or sweep all indexed rows. Older/shared migrations retain the full
  // bootstrap: some historical migrations require those base tables to exist.
  if (isProjectSchemaTrimCurrent(db)) {
    const currentVersion = getSchemaVersion(db);
    const onlyCentralUpdates = MIGRATIONS
      .filter((migration) => migration.version > currentVersion)
      .every((migration) => migration.scope === 'central');
    if (currentVersion >= latestVersion || onlyCentralUpdates) {
      if (currentVersion < latestVersion) runMigrations(db, { scope: 'project' });
      assertSessionScopedSqliteAbsent(db);
      return;
    }
  }
  initSchema(db);
  runMigrations(db, { scope: 'project' });
  trimProjectSchema(db);
  // Project DBs do not carry the global layout marker after trimming, but they
  // are still forbidden from retaining any operational session table/column.
  assertSessionScopedSqliteAbsent(db);
}

export function getProjectSchemaVersion(db: DB): number {
  return getSchemaVersion(db);
}
