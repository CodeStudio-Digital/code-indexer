import { existsSync, statSync } from 'node:fs';
import { Database, type DB } from '../db/types.js';
import { copyProjectData } from './copy-engine.js';
import { verifySplit } from './verify.js';
import { ensureCentralBackup } from './backup.js';
import type { SplitClass } from './manifest.js';

const MAX_ATTEMPTS = 3;
const TERMINAL = new Set(['done']);

export interface SplitDeps {
  /** Central DB handle — source for the copy + marker store. */
  central: DB;
  /** Central DB file path — for ATTACH + the one-time backup. */
  centralDbPath: string;
  /** Target project DB file path. */
  projectDbPath: string;
  projectId: number;
  /** Opens a fresh project DB at `path` with the full schema applied. */
  openFreshProjectDb: (path: string) => DB;
  classes?: SplitClass[];
  /** An explicit repair can retry one exhausted project after its cause is corrected. */
  retryFailed?: boolean;
  /** When 'immediate', purge central rows after verify. Default: defer (no purge). */
  purgeMode?: 'defer' | 'immediate';
}

export interface SplitOutcome {
  status: 'done' | 'failed' | 'skipped';
  reason?: string;
  copied?: number;
}

function readStatus(central: DB, projectId: number): { status: string; attempts: number; synthetic: boolean } | undefined {
  const row = central.prepare(
    `SELECT db_split_status AS s, db_split_attempts AS a, COALESCE(is_synthetic,0) AS syn
       FROM projects WHERE id = ?`,
  ).get(projectId) as { s?: string; a?: number; syn?: number } | undefined;
  return row && { status: row.s ?? 'pending', attempts: row.a ?? 0, synthetic: row.syn === 1 };
}

function setStatus(central: DB, projectId: number, status: string, err?: string | null): void {
  central.prepare(
    `UPDATE projects SET db_split_status = ?, db_split_at = datetime('now'), db_split_err = ?
       WHERE id = ?`,
  ).run(status, err ?? null, projectId);
}

function bumpAttempts(central: DB, projectId: number): void {
  central.prepare(`UPDATE projects SET db_split_attempts = db_split_attempts + 1 WHERE id = ?`)
    .run(projectId);
}

/** Old unfinished bootstraps can be upgraded in place when entirely empty.
 * Preserve an unrecognized populated database for explicit reconciliation. */
function protectExistingData(path: string, centralPath: string, projectId: number): void {
  if (!existsSync(path)) return;
  const centralFile = statSync(centralPath, { bigint: true });
  const target = statSync(path, { bigint: true });
  if (target.dev === centralFile.dev && target.ino === centralFile.ino) {
    throw new Error('Project index resolves to the central database');
  }
  const db = new Database(path, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").pluck().all() as string[];
    if (tables.includes('schema_version') && db.prepare('SELECT 1 FROM schema_version LIMIT 1').get()) {
      if (tables.includes('files') && db.prepare('SELECT 1 FROM files WHERE project_id <> ? LIMIT 1').get(projectId)) {
        throw new Error('Existing index contains files owned by another project');
      }
      return;
    }
    for (const table of tables) {
      if (db.prepare(`SELECT 1 FROM "${table.replaceAll('"', '""')}" LIMIT 1`).get()) {
        throw new Error('Unversioned project database contains data; reconciliation required');
      }
    }
  } finally { db.close(); }
}

export function splitProject(deps: SplitDeps): SplitOutcome {
  const { central, centralDbPath, projectDbPath, projectId } = deps;
  const classes = deps.classes ?? ['INDEX'];
  const initial = readStatus(central, projectId);
  if (!initial) return { status: 'skipped', reason: 'unknown project' };
  const { status, attempts, synthetic } = initial;
  if (projectId === 0 || synthetic) return { status: 'skipped', reason: 'sentinel/synthetic' };
  if (TERMINAL.has(status)) return { status: 'done' };
  if (status === 'failed' && attempts >= MAX_ATTEMPTS && !deps.retryFailed) {
    return { status: 'failed', reason: 'max attempts reached' };
  }
  let proj: DB | undefined;
  try {
    const version = central.prepare('SELECT MAX(version) FROM schema_version').pluck().get() as number;
    ensureCentralBackup(central, centralDbPath, version);
    const claimed = central.transaction(() => {
      if (readStatus(central, projectId)?.status === 'done') return false;
      bumpAttempts(central, projectId);
      setStatus(central, projectId, 'copying');
      return true;
    }).immediate();
    if (!claimed) return { status: 'done' };
    protectExistingData(projectDbPath, centralDbPath, projectId);
    proj = deps.openFreshProjectDb(projectDbPath);
    const target = proj;
    // Pin a central read snapshot. Only take the central write lock for publishing;
    // SQLite rejects the upgrade if a different writer committed during the copy.
    return central.transaction((): SplitOutcome => {
      if (readStatus(central, projectId)?.status === 'done') return { status: 'done' };
      const copy = copyProjectData(target, centralDbPath, projectId, classes, () => {
        const verdict = verifySplit(target, central, projectId, classes);
        if (!verdict.ok) throw new Error(verdict.reason);
        // Reserve publication before the target commits. A stale central snapshot
        // then rolls back the target too; a retry can import the newer rows.
        setStatus(central, projectId, 'verified');
      });
      central.prepare(`UPDATE projects SET db_split_status='done', db_split_at=datetime('now'),
        db_split_err=NULL, db_path=? WHERE id=?`).run(projectDbPath, projectId);
      return { status: 'done', copied: copy.total };
    })();
  } catch (error) {
    const reason = (error as Error).message;
    if (readStatus(central, projectId)?.status === 'done') return { status: 'done' };
    central.prepare(`UPDATE projects SET db_split_status='failed', db_split_at=datetime('now'),
      db_split_err=? WHERE id=? AND db_split_status <> 'done'`).run(reason, projectId);
    return { status: 'failed', reason };
  } finally {
    proj?.close();
  }
}

export { copyProjectData } from './copy-engine.js';
export { verifySplit, type VerifyResult } from './verify.js';
export { ensureCentralBackup, backupPathFor } from './backup.js';
export { INDEX_TABLES, manifestFor, type SplitClass, type ManifestEntry } from './manifest.js';
export { purgeProjectIndex, vacuumCentral, type PurgeResult } from './purge.js';
