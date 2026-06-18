/**
 * Sunset detection for the tiered-hybrid split (plan §8.12).
 *
 * The whole `db-split` subsystem is transitional. Once every row-bearing
 * project has migrated AND the central DB no longer holds project-scoped rows
 * (except the user-memory sentinel, id 0), we flip a global flag. That flag is
 * the precondition for the FUTURE removal PR that deletes this module, the
 * dual-read shims, and the now-empty central project tables.
 *
 * IMPORTANT — exact removal condition (also recorded in user memory
 * `project_per_project_db_split`):
 *   app_settings.db_split_complete = '1'
 *   AND  no project with id<>0 AND NOT is_synthetic AND db_split_status<>'done'
 *   AND  canary central tables hold only project_id IN (0).
 */
import type { DB } from '../db/types.js';

export const SPLIT_COMPLETE_KEY = 'db_split_complete';

/** Central tables that must be drained (sentinel id 0 aside) before sunset. */
const CANARY_TABLES = ['files', 'symbols', 'coder_sessions'] as const;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function hasSyntheticColumn(db: DB): boolean {
  return (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]).some(
    (c) => c.name === 'is_synthetic',
  );
}

/** Are there projects still awaiting migration? (excludes id 0 + synthetics). */
export function pendingProjectCount(central: DB): number {
  const synFilter = hasSyntheticColumn(central) ? 'AND COALESCE(is_synthetic,0) = 0' : '';
  const row = central.prepare(
    `SELECT COUNT(*) n FROM projects
       WHERE id <> 0 ${synFilter} AND db_split_status <> 'done'`,
  ).get() as { n: number };
  return row.n;
}

/** Do the canary central tables still hold project rows (beyond the sentinel)? */
export function centralStillHasProjectRows(central: DB): boolean {
  for (const t of CANARY_TABLES) {
    if (!tableExists(central, t)) continue;
    const cols = (central.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!cols.includes('project_id')) continue;
    const row = central.prepare(
      `SELECT EXISTS(SELECT 1 FROM "${t}" WHERE project_id NOT IN (0)) AS e`,
    ).get() as { e: number };
    if (row.e === 1) return true;
  }
  return false;
}

/** True when the split is fully done and central is drained. */
export function isSplitComplete(central: DB): boolean {
  return pendingProjectCount(central) === 0 && !centralStillHasProjectRows(central);
}

/**
 * Set the global completion flag if the split is fully done. Returns true if
 * the flag is now set. Safe to call repeatedly (idempotent). NOTE: until the
 * deferred purge actually drains central (P5+/P6), `centralStillHasProjectRows`
 * keeps this from firing — which is correct.
 */
export function markSplitCompleteIfDone(central: DB): boolean {
  if (readSplitComplete(central)) return true;
  if (!isSplitComplete(central)) return false;
  central.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`,
  ).run(SPLIT_COMPLETE_KEY);
  return true;
}

export function readSplitComplete(central: DB): boolean {
  if (!tableExists(central, 'app_settings')) return false;
  const row = central.prepare(`SELECT value v FROM app_settings WHERE key = ?`)
    .get(SPLIT_COMPLETE_KEY) as { v?: string } | undefined;
  return row?.v === '1';
}
