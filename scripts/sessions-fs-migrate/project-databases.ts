import {
  existsSync,
  lstatSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type {
  ProjectRow,
  SqliteDatabase,
} from './model.js';
import {
  assertDatabaseIntegrity,
  checkpointWal,
  databaseFingerprint,
  openDatabase,
  quoteIdentifier,
  tableColumns,
  tableExists,
  tableRowCount,
} from './db.js';
import {
  DELETE_ROW_DISPOSITIONS,
  DROP_TABLES,
  REDUNDANT_PROJECTION_TABLES,
} from './manifest.js';
import {
  assertCleanDatabase,
} from './verify.js';
import {
  assertEssentialDigest,
  captureEssentialDigest,
  createCleanClone,
  type EssentialDigest,
} from './cleaner.js';

export interface ProjectDatabaseCandidate {
  projectId: number;
  path: string;
}

export interface ProjectDatabaseAudit extends ProjectDatabaseCandidate {
  sourceFingerprint: string;
  sourceBytes: number;
  sessionRows: Record<string, number>;
  needsCleanup: boolean;
}

export interface PreparedProjectDatabase extends ProjectDatabaseAudit {
  cleanPath: string;
  essential: EssentialDigest;
}

function candidatePaths(
  project: ProjectRow,
  dataDir: string,
): string[] {
  const paths = [
    typeof project.db_path === 'string' && project.db_path.trim()
      ? project.db_path
      : null,
    typeof project.root_path === 'string' && project.root_path.trim()
      ? join(project.root_path, '.mcp-indexer', 'index.db')
      : null,
    join(dataDir, 'projects-db', `p${project.id}`, 'index.db'),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(paths.map((value) => resolve(value)))];
}

/**
 * Find every live per-project DB location without probing/creating directories.
 * A project stamped as split/done must not silently lose its persisted DB.
 */
export function discoverProjectDatabases(
  projects: readonly ProjectRow[],
  dataDir: string,
  centralDbPath: string,
): ProjectDatabaseCandidate[] {
  const central = resolve(centralDbPath);
  const output = new Map<string, ProjectDatabaseCandidate>();
  for (const project of projects) {
    if (Number(project.id) === 0 || Boolean(project.is_synthetic)) continue;
    const candidates = candidatePaths(project, dataDir);
    const existing = candidates.filter((path) => existsSync(path));
    if (
      project.db_split_status === 'done'
      && typeof project.db_path === 'string'
      && project.db_path.trim()
      && !existsSync(resolve(project.db_path))
    ) {
      throw new Error(
        `project ${project.id} is marked split/done but its SQLite DB is unavailable: ${resolve(project.db_path)}`,
      );
    }
    for (const path of existing) {
      if (path === central) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`project SQLite path is not a regular file: ${path}`);
      }
      const previous = output.get(path);
      if (previous && previous.projectId !== Number(project.id)) {
        throw new Error(
          `project SQLite path is shared by projects ${previous.projectId} and ${project.id}: ${path}`,
        );
      }
      output.set(path, { projectId: Number(project.id), path });
    }
  }
  return [...output.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function encodeCell(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Buffer.isBuffer(value)) return `blob:${value.toString('base64')}`;
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  return `${typeof value}:${String(value)}`;
}

function rowsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  columns: readonly string[],
): boolean {
  return columns.every((column) => encodeCell(left[column]) === encodeCell(right[column]));
}

/**
 * Project DBs used to receive FEATURE copies and
 * mixed project/session tables. The central DB remained authoritative, so the
 * offline cut may remove a local row only after proving the exact row also
 * exists in the central source that is being exported.
 */
function assertRowsMirroredInCentral(
  local: SqliteDatabase,
  central: SqliteDatabase,
  table: string,
  whereSql?: string,
): number {
  if (!tableExists(local, table)) return 0;
  const rows = tableRowCount(local, table, whereSql);
  if (rows === 0) return 0;
  if (!tableExists(central, table)) {
    throw new Error(
      `project DB contains ${rows} session row(s) in ${table}, but the central source has no such table`,
    );
  }

  const localInfo = local.prepare(
    `PRAGMA table_info(${quoteIdentifier(table)})`,
  ).all() as Array<{ name: string; pk: number }>;
  const columns = localInfo.map((row) => row.name);
  const centralColumns = new Set(tableColumns(central, table));
  const missingColumns = columns.filter((column) => !centralColumns.has(column));
  if (missingColumns.length > 0) {
    throw new Error(
      `cannot prove project ${table} rows were exported; central source lacks columns ${missingColumns.join(', ')}`,
    );
  }
  const primaryKey = localInfo
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
  if (primaryKey.length === 0) {
    throw new Error(
      `cannot prove ${rows} project ${table} row(s) are mirrored because the table has no primary key`,
    );
  }

  const where = whereSql ? ` WHERE ${whereSql}` : '';
  const selectColumns = columns.map(quoteIdentifier).join(', ');
  const localStatement = local.prepare(
    `SELECT ${selectColumns} FROM ${quoteIdentifier(table)}${where}`,
  );
  const centralStatement = central.prepare(
    `SELECT ${selectColumns}
       FROM ${quoteIdentifier(table)}
      WHERE ${primaryKey.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ')}`,
  );
  for (const localRow of localStatement.iterate() as Iterable<Record<string, unknown>>) {
    const key = primaryKey.map((column) => localRow[column]);
    const centralRow = centralStatement.get(...key) as Record<string, unknown> | undefined;
    if (!centralRow || !rowsEqual(localRow, centralRow, columns)) {
      throw new Error(
        `project DB has divergent session state in ${table} at key ${JSON.stringify(key.map(encodeCell))}`,
      );
    }
  }
  return rows;
}

function inspectOpenProjectDatabase(
  local: SqliteDatabase,
  central: SqliteDatabase,
): { sessionRows: Record<string, number>; needsCleanup: boolean } {
  const sessionRows: Record<string, number> = {};
  let needsCleanup = false;
  const redundant = new Set<string>(REDUNDANT_PROJECTION_TABLES);

  for (const table of DROP_TABLES) {
    if (!tableExists(local, table)) continue;
    needsCleanup = true;
    if (redundant.has(table)) continue;
    const rows = assertRowsMirroredInCentral(local, central, table);
    if (rows > 0) sessionRows[table] = rows;
  }
  for (const disposition of DELETE_ROW_DISPOSITIONS) {
    if (!tableExists(local, disposition.table)) continue;
    const columns = new Set(tableColumns(local, disposition.table));
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
        `cannot audit project ${disposition.table} predicate; missing columns: ${
          missingPredicateColumns.join(', ')
        }`,
      );
    }
    if (disposition.dropColumns?.some((column) => columns.has(column))) {
      needsCleanup = true;
    }
    let rows = 0;
    try {
      rows = assertRowsMirroredInCentral(
        local,
        central,
        disposition.table,
        disposition.whereSql,
      );
    } catch (error) {
      const predicateUnavailable =
        disposition.dropColumns?.length
        && disposition.dropColumns.every((column) => !columns.has(column));
      if (!predicateUnavailable) throw error;
    }
    if (rows > 0) {
      needsCleanup = true;
      sessionRows[disposition.table] = rows;
    }
  }
  return { sessionRows, needsCleanup };
}

export function auditProjectDatabases(
  central: SqliteDatabase,
  candidates: readonly ProjectDatabaseCandidate[],
  options: { checkpoint: boolean },
): ProjectDatabaseAudit[] {
  const output: ProjectDatabaseAudit[] = [];
  for (const candidate of candidates) {
    const local = openDatabase(candidate.path, {
      readonly: !options.checkpoint,
      fileMustExist: true,
    });
    try {
      if (options.checkpoint) checkpointWal(local);
      assertDatabaseIntegrity(local);
      let inspected: ReturnType<typeof inspectOpenProjectDatabase>;
      try {
        inspected = inspectOpenProjectDatabase(local, central);
      } catch (error) {
        throw new Error(
          `project DB audit failed for ${candidate.path}: ${(error as Error).message}`,
          { cause: error },
        );
      }
      output.push({
        ...candidate,
        sourceFingerprint: databaseFingerprint(candidate.path),
        sourceBytes: statSync(candidate.path).size,
        ...inspected,
      });
    } finally {
      local.close();
    }
  }
  return output;
}

function cleanPathFor(
  audit: ProjectDatabaseAudit,
  sourceFingerprint: string,
): string {
  const identity = createHash('sha256')
    .update(resolve(audit.path))
    .digest('hex')
    .slice(0, 12);
  return join(
    dirname(audit.path),
    `.index.db.sessions-fs-${sourceFingerprint.slice(0, 20)}-${identity}.clean`,
  );
}

export function prepareCleanProjectDatabases(
  audits: readonly ProjectDatabaseAudit[],
  sourceFingerprint: string,
): PreparedProjectDatabase[] {
  const prepared: PreparedProjectDatabase[] = [];
  for (const audit of audits) {
    if (!audit.needsCleanup) continue;
    const local = openDatabase(audit.path, { readonly: true, fileMustExist: true });
    let essential: EssentialDigest;
    try {
      assertDatabaseIntegrity(local);
      essential = captureEssentialDigest(local);
    } finally {
      local.close();
    }
    const cleanPath = cleanPathFor(audit, sourceFingerprint);
    const cleanEssential = createCleanClone(
      audit.path,
      cleanPath,
      essential,
      {
        writeLayoutMarker: false,
      },
    );
    smokeCleanProjectDatabase(cleanPath, cleanEssential);
    prepared.push({
      ...audit,
      cleanPath,
      essential: cleanEssential,
    });
  }
  return prepared;
}

export function smokeCleanProjectDatabase(
  path: string,
  expectedEssential: EssentialDigest,
): void {
  const db = openDatabase(path, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseIntegrity(db);
    assertCleanDatabase(db);
    assertEssentialDigest(expectedEssential, db);
  } finally {
    db.close();
  }
}

export function verifyProjectDatabasesClean(
  candidates: readonly ProjectDatabaseCandidate[],
): number {
  let verified = 0;
  for (const candidate of candidates) {
    const db = openDatabase(candidate.path, { readonly: true, fileMustExist: true });
    try {
      assertDatabaseIntegrity(db);
      assertCleanDatabase(db);
      verified += 1;
    } finally {
      db.close();
    }
  }
  return verified;
}
