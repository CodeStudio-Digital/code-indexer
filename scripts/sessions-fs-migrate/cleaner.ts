import {
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { SqliteDatabase } from './model.js';
import { SESSION_LAYOUT_VERSION } from './model.js';
import {
  DELETE_ROW_DISPOSITIONS,
  DROP_TABLES,
  POST_CUT_ROW_GUARDS,
  REDUNDANT_PROJECTION_TABLES,
  TABLE_DISPOSITIONS,
} from './manifest.js';
import {
  assertDatabaseIntegrity,
  checkpointWal,
  openDatabase,
  quoteIdentifier,
  tableColumns,
  tableExists,
} from './db.js';
import { copyFileVerified, syncParentDirectory } from './fs-ops.js';
import { assertCleanDatabase, assertPostCutWriteGuards } from './verify.js';
import {
  projectBuilderJsonWithDesignUuid,
  rewriteProjectDesignSystemLinks,
  type DesignSessionIdRemap,
} from './design-system-links.js';

export interface EssentialTableDigest {
  rows: number;
  sha256: string;
}

export type EssentialDigest = Record<string, EssentialTableDigest>;

function updateValueHash(hash: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null || value === undefined) {
    hash.update('n:;');
    return;
  }
  if (Buffer.isBuffer(value)) {
    hash.update(`b:${value.length}:`);
    hash.update(value);
    hash.update(';');
    return;
  }
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  hash.update(`${typeof value}:${Buffer.byteLength(text)}:${text};`);
}

function digestTable(
  db: SqliteDatabase,
  table: string,
  whereSql?: string,
  selectedColumns?: readonly string[],
  transformRow?: (
    row: Record<string, unknown>,
  ) => Record<string, unknown>,
): EssentialTableDigest {
  const info = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  const columns = selectedColumns ? [...selectedColumns] : info.map((row) => row.name);
  const selected = new Set(columns);
  const pk = info
    .filter((row) => row.pk > 0 && selected.has(row.name))
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  const orderBy = pk.length > 0
    ? ` ORDER BY ${pk.map(quoteIdentifier).join(', ')}`
    : ' ORDER BY rowid';
  const where = whereSql ? ` WHERE ${whereSql}` : '';
  const statement = db.prepare(
    `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}${where}${orderBy}`,
  );
  const hash = createHash('sha256');
  let rows = 0;
  for (const sourceRow of statement.iterate() as Iterable<Record<string, unknown>>) {
    const row = transformRow ? transformRow(sourceRow) : sourceRow;
    rows += 1;
    hash.update('row{');
    for (const column of columns) {
      hash.update(`${column}=`);
      updateValueHash(hash, row[column]);
    }
    hash.update('}');
  }
  return { rows, sha256: hash.digest('hex') };
}

export interface EssentialDigestOptions {
  designSessionIdRemap?: DesignSessionIdRemap;
  /**
   * Central clean clones carry the global layout marker. Per-project SQLite
   * files deliberately do not: their normal project migration lineage creates
   * and then trims app_settings on the next writable open.
   */
  writeLayoutMarker?: boolean;
}

export function captureEssentialDigest(
  db: SqliteDatabase,
  options: EssentialDigestOptions = {},
): EssentialDigest {
  const projectionFor = (
    table: string,
  ): ((row: Record<string, unknown>) => Record<string, unknown>) | undefined =>
    table === 'projects' && options.designSessionIdRemap
      ? (source): Record<string, unknown> => {
          if (!Object.hasOwn(source, 'builder_json')) return source;
          const next = projectBuilderJsonWithDesignUuid(
            source.builder_json,
            options.designSessionIdRemap!,
            `Project ${String(source.id)}`,
          );
          return next.changed
            ? { ...source, builder_json: next.value }
            : source;
        }
      : undefined;
  const excluded = new Set(TABLE_DISPOSITIONS.map((item) => item.table));
  for (const table of REDUNDANT_PROJECTION_TABLES) excluded.add(table);
  const shadowTables = new Set(
    (db.prepare('PRAGMA table_list').all() as Array<{
      name: string;
      type: string;
    }>)
      .filter((row) => row.type === 'shadow')
      .map((row) => row.name),
  );
  const tables = (db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all() as Array<{ name: string; sql: string | null }>)
    .filter((row) => !excluded.has(row.name))
    // FTS/RTree shadow tables are implementation details of their virtual
    // parent and may be recreated by the application smoke. Digest the
    // canonical source rows instead of treating rebuilt indexes as catalogs.
    .filter((row) => !shadowTables.has(row.name))
    .filter((row) => !/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ''));
  const output: EssentialDigest = Object.fromEntries(tables.map((row) => (
    [
      row.name,
      digestTable(
        db,
        row.name,
        row.name === 'app_settings'
          ? "key <> 'session_storage_layout_version'"
          : row.name === 'schema_version'
            ? 'version <> 263'
            : undefined,
        undefined,
        projectionFor(row.name),
      ),
    ] as const
  )));
  for (const disposition of DELETE_ROW_DISPOSITIONS) {
    if (!tableExists(db, disposition.table)) continue;
    const columns = tableColumns(db, disposition.table)
      .filter((column) => !(disposition.dropColumns ?? []).includes(column));
    const availableColumns = new Set(tableColumns(db, disposition.table));
    const missingPredicateColumns = (disposition.predicateColumns ?? [])
      .filter((column) => !availableColumns.has(column));
    let digest: EssentialTableDigest;
    if (
      missingPredicateColumns.length > 0 &&
      disposition.missingPredicateMeansNoMatch
    ) {
      digest = digestTable(
        db,
        disposition.table,
        undefined,
        columns,
        projectionFor(disposition.table),
      );
    } else {
      try {
        digest = digestTable(
          db,
          disposition.table,
          `NOT (${disposition.whereSql})`,
          columns,
          projectionFor(disposition.table),
        );
      } catch (error) {
        const removed = disposition.dropColumns?.length
          && disposition.dropColumns.every((column) => !availableColumns.has(column));
        if (!removed) throw error;
        digest = digestTable(
          db,
          disposition.table,
          undefined,
          columns,
          projectionFor(disposition.table),
        );
      }
    }
    output[disposition.table] = digest;
  }
  return output;
}

export function assertEssentialDigest(
  expected: EssentialDigest,
  db: SqliteDatabase,
  options: EssentialDigestOptions = {},
): void {
  const actual = captureEssentialDigest(db, options);
  const errors: string[] = [];
  for (const [table, digest] of Object.entries(expected)) {
    const found = actual[table];
    if (!found) errors.push(`${table}: missing`);
    else if (found.rows !== digest.rows || found.sha256 !== digest.sha256) {
      errors.push(
        `${table}: expected rows=${digest.rows} hash=${digest.sha256}, got rows=${found.rows} hash=${found.sha256}`,
      );
    }
  }
  const unexpected = Object.keys(actual).filter((table) => !expected[table]);
  if (unexpected.length > 0) errors.push(`unexpected essential tables: ${unexpected.join(', ')}`);
  if (errors.length > 0) throw new Error(`essential SQLite data changed:\n${errors.join('\n')}`);
}

function dependentObjects(
  db: SqliteDatabase,
  table: string,
  column: string,
): Array<{ type: 'index' | 'trigger' | 'view'; name: string; sql: string }> {
  const columnToken = new RegExp(`(^|[^a-zA-Z0-9_])${column}([^a-zA-Z0-9_]|$)`, 'i');
  const tableToken = new RegExp(`(^|[^a-zA-Z0-9_])${table}([^a-zA-Z0-9_]|$)`, 'i');
  return (db.prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND (
       (tbl_name = ? AND type IN ('index', 'trigger'))
       OR type = 'view'
     )`,
  ).all(table) as Array<{ type: 'index' | 'trigger' | 'view'; name: string; sql: string }>)
    .filter((row) => columnToken.test(row.sql))
    .filter((row) => row.type !== 'view' || tableToken.test(row.sql));
}

function dropMixedColumn(db: SqliteDatabase, table: string, column: string): void {
  if (!tableColumns(db, table).includes(column)) return;
  for (const object of dependentObjects(db, table, column)) {
    if (object.type === 'view') {
      throw new Error(
        `cannot remove ${table}.${column}: view ${object.name} depends on it and has no explicit disposition`,
      );
    }
    db.exec(`DROP ${object.type.toUpperCase()} IF EXISTS ${quoteIdentifier(object.name)}`);
  }
  db.exec(
    `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)}`,
  );
}

function setLayoutMarker(db: SqliteDatabase): void {
  if (!tableExists(db, 'app_settings')) {
    throw new Error('clean DB has no app_settings table for session layout marker');
  }
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('session_storage_layout_version', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(String(SESSION_LAYOUT_VERSION));
}

export function createCleanClone(
  sourceDbPath: string,
  cleanDbPath: string,
  expectedEssential: EssentialDigest,
  options: EssentialDigestOptions = {},
): EssentialDigest {
  if (!existsSync(sourceDbPath)) throw new Error(`source DB missing: ${sourceDbPath}`);
  if (existsSync(cleanDbPath)) {
    // Rebuild an interrupted clone. Its post-cascade essential digest is
    // intentionally derived below from a byte-verified fresh source copy.
    removeExactFile(cleanDbPath);
    removeExactFile(`${cleanDbPath}-wal`);
    removeExactFile(`${cleanDbPath}-shm`);
  } else {
    removeExactFile(`${cleanDbPath}-wal`);
    removeExactFile(`${cleanDbPath}-shm`);
  }

  copyFileVerified(sourceDbPath, cleanDbPath);
  const db = openDatabase(cleanDbPath, { fileMustExist: true });
  try {
    assertDatabaseIntegrity(db);

    const permanentRowGuards = new Set<string>(
      POST_CUT_ROW_GUARDS.map((guard) => guard.table),
    );
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const disposition of DELETE_ROW_DISPOSITIONS) {
        if (!tableExists(db, disposition.table)) continue;
        const columns = new Set(tableColumns(db, disposition.table));
        const missingPredicateColumns = (disposition.predicateColumns ?? [])
          .filter((column) => !columns.has(column));
        if (
          missingPredicateColumns.length > 0 &&
          disposition.missingPredicateMeansNoMatch
        ) {
          continue;
        }
        if (missingPredicateColumns.length > 0) {
          throw new Error(
            `cannot evaluate ${disposition.table} cleanup predicate; missing columns: ${
              missingPredicateColumns.join(', ')
            }`,
          );
        }
        if (disposition.dropColumns?.length
          && disposition.dropColumns.every((column) => !columns.has(column))
          && !permanentRowGuards.has(disposition.table)) {
          continue;
        }
        db.exec(
          `DELETE FROM ${quoteIdentifier(disposition.table)} WHERE ${disposition.whereSql}`,
        );
      }
      for (const disposition of DELETE_ROW_DISPOSITIONS) {
        if (!tableExists(db, disposition.table)) continue;
        for (const column of disposition.dropColumns ?? []) {
          dropMixedColumn(db, disposition.table, column);
        }
      }

      // Drop the FTS virtual table before ordinary tables; SQLite removes its
      // internal triggers/shadows atomically. Explicit shadow DROP entries below
      // are idempotent and cover damaged/legacy schemas where they survived.
      for (const table of REDUNDANT_PROJECTION_TABLES) {
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
      }
      const redundant = new Set<string>(REDUNDANT_PROJECTION_TABLES);
      for (const table of [...DROP_TABLES].reverse()) {
        if (redundant.has(table)) continue;
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
      }
      rewriteProjectDesignSystemLinks(
        db,
        options.designSessionIdRemap ?? new Map(),
      );
      if (options.writeLayoutMarker !== false) setLayoutMarker(db);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
    db.pragma('foreign_keys = ON');
    db.exec('VACUUM');
    checkpointWal(db);
    assertDatabaseIntegrity(db);
    assertCleanDatabase(db);
    assertEssentialDigest(expectedEssential, db);
  } finally {
    db.close();
  }
  return expectedEssential;
}

export interface DatabaseSwap {
  oldDbPath: string;
  rollback(): void;
  finalize(): void;
}

export type DatabaseSwapFaultPoint =
  | 'db-swap:before-source-rename'
  | 'db-swap:after-source-rename'
  | 'db-swap:before-sidecar-rename'
  | 'db-swap:after-sidecar-rename'
  | 'db-swap:before-clean-rename'
  | 'db-swap:after-clean-rename'
  | 'db-swap:before-parent-fsync'
  | 'db-swap:after-parent-fsync';

export interface DatabaseSwapFaultContext {
  point: DatabaseSwapFaultPoint;
  source?: string;
  destination?: string;
  path?: string;
}

export type DatabaseSwapFaultInjector = (
  context: DatabaseSwapFaultContext,
) => void;

export interface DatabaseSwapOptions {
  /**
   * Test-only crash/fault seam. Production callers leave this unset.
   * Forward-swap failures are automatically rolled back before being rethrown.
   */
  faultInjector?: DatabaseSwapFaultInjector;
}

export function databaseSwapBackupPath(
  dbPath: string,
  stamp: string,
): string {
  return join(
    dirname(dbPath),
    `${basename(dbPath)}.pre-session-fs-${stamp}`,
  );
}

function removeExactFile(path: string): void {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`refusing to remove non-file cleanup target: ${path}`);
  rmSync(path, { force: false });
}

export function swapCleanDatabase(
  dbPath: string,
  cleanDbPath: string,
  stamp: string,
  options: DatabaseSwapOptions = {},
): DatabaseSwap {
  const parent = dirname(dbPath);
  if (dirname(cleanDbPath) !== parent) {
    throw new Error('clean DB must be staged in the same directory/volume as the source DB');
  }
  const oldDbPath = databaseSwapBackupPath(dbPath, stamp);
  if (existsSync(oldDbPath)) throw new Error(`old DB swap target already exists: ${oldDbPath}`);
  const sidecars = ['-wal', '-shm'] as const;
  const movedSidecars: Array<{ old: string; backup: string }> = [];
  let sourceMoved = false;
  let cleanActivated = false;

  const inject = (context: DatabaseSwapFaultContext): void => {
    options.faultInjector?.(context);
  };
  const restoreForwardFailure = (): void => {
    if (cleanActivated && existsSync(dbPath)) {
      if (existsSync(cleanDbPath)) {
        throw new Error(`cannot restore failed clean DB because staging target exists: ${cleanDbPath}`);
      }
      renameSync(dbPath, cleanDbPath);
      cleanActivated = false;
    }
    if (sourceMoved && existsSync(oldDbPath)) {
      renameSync(oldDbPath, dbPath);
      sourceMoved = false;
    }
    for (const sidecar of [...movedSidecars].reverse()) {
      if (existsSync(sidecar.backup)) renameSync(sidecar.backup, sidecar.old);
    }
    syncParentDirectory(dbPath);
  };

  try {
    inject({
      point: 'db-swap:before-source-rename',
      source: dbPath,
      destination: oldDbPath,
    });
    renameSync(dbPath, oldDbPath);
    sourceMoved = true;
    inject({
      point: 'db-swap:after-source-rename',
      source: dbPath,
      destination: oldDbPath,
    });

    for (const suffix of sidecars) {
      const old = `${dbPath}${suffix}`;
      const backup = `${oldDbPath}${suffix}`;
      if (existsSync(old)) {
        inject({
          point: 'db-swap:before-sidecar-rename',
          source: old,
          destination: backup,
        });
        renameSync(old, backup);
        movedSidecars.push({ old, backup });
        inject({
          point: 'db-swap:after-sidecar-rename',
          source: old,
          destination: backup,
        });
      }
    }

    inject({
      point: 'db-swap:before-clean-rename',
      source: cleanDbPath,
      destination: dbPath,
    });
    renameSync(cleanDbPath, dbPath);
    cleanActivated = true;
    inject({
      point: 'db-swap:after-clean-rename',
      source: cleanDbPath,
      destination: dbPath,
    });
    inject({ point: 'db-swap:before-parent-fsync', path: parent });
    syncParentDirectory(dbPath);
    inject({ point: 'db-swap:after-parent-fsync', path: parent });
  } catch (error) {
    try {
      restoreForwardFailure();
    } catch (rollbackError) {
      const original = error instanceof Error ? error.message : String(error);
      const rollback = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
      throw new Error(
        `DB swap failed (${original}) and automatic rollback also failed (${rollback})`,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  let done = false;
  return {
    oldDbPath,
    rollback() {
      if (done) return;
      const failed = `${cleanDbPath}.failed-${Date.now()}`;
      if (existsSync(dbPath)) renameSync(dbPath, failed);
      for (const suffix of sidecars) {
        const activeSidecar = `${dbPath}${suffix}`;
        if (existsSync(activeSidecar)) {
          renameSync(activeSidecar, `${failed}${suffix}`);
        }
      }
      renameSync(oldDbPath, dbPath);
      for (const sidecar of movedSidecars) {
        if (existsSync(sidecar.backup)) renameSync(sidecar.backup, sidecar.old);
      }
      syncParentDirectory(dbPath);
      done = true;
    },
    finalize() {
      if (done) return;
      removeExactFile(oldDbPath);
      for (const sidecar of movedSidecars) removeExactFile(sidecar.backup);
      removeExactFile(`${cleanDbPath}-wal`);
      removeExactFile(`${cleanDbPath}-shm`);
      syncParentDirectory(dbPath);
      done = true;
    },
  };
}

export function smokeCleanDatabase(dbPath: string, expectedEssential: EssentialDigest): void {
  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseIntegrity(db);
    assertCleanDatabase(db);
    assertPostCutWriteGuards(db);
    assertEssentialDigest(expectedEssential, db);
    const marker = db.prepare(
      `SELECT value FROM app_settings WHERE key = 'session_storage_layout_version'`,
    ).get() as { value?: string } | undefined;
    if (marker?.value !== String(SESSION_LAYOUT_VERSION)) {
      throw new Error('session storage layout marker is absent or invalid');
    }
    db.prepare('SELECT id, root_path FROM projects WHERE COALESCE(is_synthetic, 0) = 0 LIMIT 1').get();
  } finally {
    db.close();
  }
}

/**
 * Exercise the same store constructor used by the application. This catches a
 * clean clone that passes raw SQLite checks but is rejected by the layout guard
 * or recreated by a pending migration. The post-close raw smoke proves the
 * application open did not reintroduce session-scoped schema or alter essential
 * rows (migration 263's schema_version marker is intentionally digest-exempt).
 */
export async function smokeCodeIndexDatabase(
  dbPath: string,
  expectedEssential: EssentialDigest,
): Promise<void> {
  const { CodeIndexDB } = await import('../../packages/store/src/db.js');
  const appDb = new CodeIndexDB(dbPath, {
    checkpointOwner: true,
    externalCheckpointer: true,
  });
  try {
    appDb.listProjects();
    const marker = appDb.raw().prepare(
      `SELECT value FROM app_settings WHERE key = 'session_storage_layout_version'`,
    ).get() as { value?: string } | undefined;
    if (marker?.value !== String(SESSION_LAYOUT_VERSION)) {
      throw new Error('CodeIndexDB smoke did not observe the filesystem-session layout marker');
    }
  } finally {
    appDb.close();
  }
  const checkpoint = openDatabase(dbPath, { fileMustExist: true });
  try {
    checkpointWal(checkpoint);
  } finally {
    checkpoint.close();
  }
  if (existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size !== 0) {
    throw new Error(`CodeIndexDB smoke left an uncheckpointed WAL: ${dbPath}-wal`);
  }
  smokeCleanDatabase(dbPath, expectedEssential);
}
