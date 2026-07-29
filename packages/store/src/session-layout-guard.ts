import type DatabaseConstructor from 'better-sqlite3';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  findForbiddenSessionSchema,
  POST_CUT_ROW_GUARDS,
  type SchemaTable,
} from '@mcp/session-storage/sqlite-disposition.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const SESSION_STORAGE_LAYOUT_KEY = 'session_storage_layout_version';
export const SESSION_STORAGE_LAYOUT_VERSION = '1';

export class LegacySessionDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacySessionDatabaseError';
  }
}

export function assertNoSessionMigrationMaintenanceLock(dbPath: string): void {
  if (dbPath === ':memory:' || dbPath.startsWith('file::memory:')) return;
  const lockPath = join(dirname(dbPath), '.sessions-fs-migrate.lock');
  if (!existsSync(lockPath)) return;
  const stat = lstatSync(lockPath);
  if (!stat.isSymbolicLink() && stat.isFile()) {
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
      if (Number(owner.pid) === process.pid) return;
    } catch {
      // Invalid owner metadata remains fail-closed below.
    }
  }
  const detail = stat.isSymbolicLink() || !stat.isFile()
    ? 'unsafe maintenance lock entry'
    : 'offline cutover is active or was interrupted';
  throw new LegacySessionDatabaseError(
    `${detail}: ${lockPath}. CodeStudio will not open SQLite until ` +
      '`pnpm sessions:fs-migrate -- --apply --delete-source-db` completes recovery.',
  );
}

function tableExists(db: DB, table: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
           FROM sqlite_master
          WHERE type = 'table' AND name = ?`,
      )
      .get(table),
  );
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}

function schemaTables(db: DB): SchemaTable[] {
  const tables = db.prepare(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  ).all() as Array<{ name: string }>;
  return tables.map((table) => ({
    name: table.name,
    columns: (
      db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  }));
}

export function readSessionStorageLayoutVersion(db: DB): string | null {
  if (!tableExists(db, 'app_settings')) return null;
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SESSION_STORAGE_LAYOUT_KEY) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

/**
 * Refuse an already-initialized SQLite database that has not gone through the
 * offline filesystem-session cutover. The only exception is a genuinely new
 * database, which is allowed to bootstrap and receives the marker in migration
 * 263. This check runs before initSchema/runMigrations, so opening the new app
 * cannot partially mutate a legacy database.
 */
export function assertSessionStorageLayoutReady(
  db: DB,
  options: { allowFreshBootstrap: boolean },
): void {
  const version = readSessionStorageLayoutVersion(db);
  if (version === SESSION_STORAGE_LAYOUT_VERSION) return;
  if (version != null) {
    throw new LegacySessionDatabaseError(
      `Unsupported filesystem session layout version ${JSON.stringify(version)}; expected ${SESSION_STORAGE_LAYOUT_VERSION}.`,
    );
  }

  if (options.allowFreshBootstrap) return;

  throw new LegacySessionDatabaseError(
    'Legacy SQLite session persistence detected. CodeStudio will not start in compatibility or dual-write mode. ' +
      'Stop Electron, workers, agents and sandboxes, then run ' +
      '`pnpm sessions:fs-migrate -- --apply --delete-source-db`.',
  );
}

export function markSessionStorageLayoutReady(db: DB): void {
  if (!tableExists(db, 'app_settings')) {
    throw new Error('app_settings must exist before marking the filesystem session layout');
  }
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(SESSION_STORAGE_LAYOUT_KEY, SESSION_STORAGE_LAYOUT_VERSION);
}

/**
 * Strong post-migration invariant. A valid marker alone is insufficient: an
 * old table, mixed session column/row, or removed write guard means some code
 * could silently resume SQLite persistence.
 */
export function assertSessionScopedSqliteAbsent(db: DB): void {
  const violations = findForbiddenSessionSchema(schemaTables(db));
  for (const guard of POST_CUT_ROW_GUARDS) {
    if (!tableExists(db, guard.table)) continue;
    if (
      db.prepare(
        `SELECT 1
           FROM ${quoteIdentifier(guard.table)}
          WHERE ${guard.whereSql}
          LIMIT 1`,
      ).get()
    ) {
      violations.push(`forbidden session rows: ${guard.table}`);
    }
    for (const suffix of ['insert', 'update'] as const) {
      const trigger = `session_fs_reject_${guard.table}_${suffix}`;
      if (
        !db.prepare(
          `SELECT 1
             FROM sqlite_master
            WHERE type = 'trigger' AND name = ?`,
        ).get(trigger)
      ) {
        violations.push(`missing filesystem-session write guard: ${trigger}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new LegacySessionDatabaseError(
      `SQLite contains forbidden session persistence after layout cutover:\n${violations.join('\n')}`,
    );
  }
}
