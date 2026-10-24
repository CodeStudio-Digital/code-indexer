import { statSync } from 'node:fs';
import type { SourceInventory, SqliteDatabase, ProjectRow } from './model.js';
import {
  DELETE_ROW_DISPOSITIONS,
  DROP_TABLES,
  POST_CUT_ROW_GUARDS,
  REDUNDANT_PROJECTION_TABLES,
  TABLE_DISPOSITIONS,
} from './manifest.js';
import {
  databaseFingerprint,
  tableColumns,
  tableExists,
  tableRowCount,
} from './db.js';

function integerIds(db: SqliteDatabase, table: string): number[] {
  if (!tableExists(db, table)) return [];
  return (db.prepare(`SELECT id FROM "${table}" ORDER BY id`).all() as Array<{ id: unknown }>)
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id));
}

function scalarIds(db: SqliteDatabase, table: string): Array<number | string> {
  if (!tableExists(db, table)) return [];
  return (db.prepare(`SELECT id FROM "${table}" ORDER BY id`).all() as Array<{ id: unknown }>)
    .flatMap((row) => (
      typeof row.id === 'string' || typeof row.id === 'number' ? [row.id] : []
    ));
}

export function inventoryProjects(db: SqliteDatabase): ProjectRow[] {
  if (!tableExists(db, 'projects')) {
    throw new Error('legacy DB has no projects table');
  }
  const columns = (db.prepare('PRAGMA table_info("projects")').all() as Array<{ name: string }>)
    .map((row) => row.name);
  const nameSelect = columns.includes('name') ? ', name' : '';
  const syntheticSelect = columns.includes('is_synthetic') ? ', is_synthetic' : '';
  const dbPathSelect = columns.includes('db_path') ? ', db_path' : '';
  const splitStatusSelect = columns.includes('db_split_status') ? ', db_split_status' : '';
  return db.prepare(
    `SELECT id, root_path${nameSelect}${syntheticSelect}${dbPathSelect}${splitStatusSelect}
       FROM projects
      ORDER BY id`,
  ).all() as ProjectRow[];
}

export function inventorySource(db: SqliteDatabase, dbPath: string): SourceInventory {
  const tableSql = new Map(
    (db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table'`,
    ).all() as Array<{ name: string; sql: string | null }>)
      .map((row) => [row.name, row.sql]),
  );
  const tables: SourceInventory['tables'] = {};
  const permanentRowGuards = new Set<string>(
    POST_CUT_ROW_GUARDS.map((guard) => guard.table),
  );

  for (const disposition of TABLE_DISPOSITIONS) {
    const columns = new Set(tableColumns(db, disposition.table));
    const optionalMixedColumnMissing = disposition.kind === 'delete_rows'
      && disposition.dropColumns?.length
      && disposition.dropColumns.every((column) => !columns.has(column));
    const redundant = (REDUNDANT_PROJECTION_TABLES as readonly string[]).includes(disposition.table);
    const rowCount = redundant || (optionalMixedColumnMissing && !permanentRowGuards.has(disposition.table))
      ? 0
      : disposition.kind === 'drop'
        ? tableRowCount(db, disposition.table)
        : tableRowCount(db, disposition.table, disposition.whereSql);
    tables[disposition.table] = {
      disposition: disposition.kind,
      rows: rowCount,
      sql: tableSql.get(disposition.table),
    };
  }

  const dbBytes = statSync(dbPath).size;
  const sessionPayloadEstimate = DROP_TABLES.reduce((total, table) => {
    const rows = tables[table]?.rows ?? 0;
    return total + Math.min(rows * 16_384, Math.max(dbBytes / 2, 64 * 1024 * 1024));
  }, 0);
  const mixedRows = DELETE_ROW_DISPOSITIONS.reduce(
    (total, disposition) => total + (tables[disposition.table]?.rows ?? 0),
    0,
  );

  return {
    dbPath,
    dbFingerprint: databaseFingerprint(dbPath),
    dbBytes,
    projects: inventoryProjects(db),
    tables,
    coderSessionIds: integerIds(db, 'coder_sessions'),
    companySessionIds: integerIds(db, 'company_sessions'),
    appStudioSessionIds: scalarIds(db, 'app_studio_sessions'),
    requiredBytes: Math.ceil(
      dbBytes * 1.35
      + Math.min(sessionPayloadEstimate, dbBytes)
      + mixedRows * 16_384
      + 512 * 1024 * 1024,
    ),
  };
}
