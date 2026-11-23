/**
 * Resolve the project-DB file path a per-project FEATURE store should bind to,
 * for contexts that have a raw central DB handle but NOT a `CodeIndexDB` router
 * (the coder worker, which re-wires the `api_*` agent tools against a fresh
 * store). Mirrors `CodeIndexDB.useProjectDb` exactly so a worker-side store
 * agrees with the main process — otherwise the api-agent would read/write the
 * central DB while the dashboard routes to the project DB, and they'd diverge.
 *
 * Returns null when routing is off (flag) or the project hasn't migrated
 * (`db_split_status !== 'done'`, synthetic, or the user-memory sentinel) — the
 * caller then keeps using the central path, byte-identical to today.
 */
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { Database, type DB } from '../db/types.js';
import { projectDbFlags } from '@mcp/shared/utils/config.js';
import { resolveProjectDbLocation } from './paths.js';

/** A portable index can belong to a different numeric id in its original catalog. */
export function canRouteNewProject(path: string, projectId: number, root: string): boolean {
  if (!existsSync(path)) return true;
  let index: DB | undefined;
  try {
    index = new Database(path, { readonly: true, fileMustExist: true });
    const owner = index.prepare('SELECT root_path FROM projects WHERE id=?').pluck().get(projectId);
    return typeof owner === 'string' && relative(root, owner) === '';
  } catch {
    return false;
  } finally { index?.close(); }
}

export function routedFeatureDbPath(central: DB, projectId: number): string | null {
  const flags = projectDbFlags();
  if (!flags.enabled || !flags.route || projectId === 0) return null;
  const row = central
    .prepare(
      `SELECT db_split_status AS s, COALESCE(is_synthetic, 0) AS syn, db_path AS p, root_path AS r
         FROM projects WHERE id = ?`,
    )
    .get(projectId) as { s?: string; syn?: number; p?: string; r?: string } | undefined;
  if (!row || row.syn === 1 || row.s !== 'done') return null;
  // A 'done' project always has db_path stamped by the split; the location
  // fallback is a defensive last resort (matches resolveProjectDbPath).
  return row.p || resolveProjectDbLocation(projectId, row.r ?? null, { forceFallback: flags.fallbackAll }).dbPath;
}
