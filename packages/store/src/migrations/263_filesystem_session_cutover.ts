import type DatabaseConstructor from 'better-sqlite3';
import {
  DELETE_ROW_DISPOSITIONS,
  DROP_TABLES,
  findForbiddenSessionSchema,
  POST_CUT_ROW_GUARDS,
  REDUNDANT_PROJECTION_TABLES,
  TABLE_DISPOSITIONS,
  type SchemaTable,
} from '@mcp/session-storage/sqlite-disposition.js';
import {
  markSessionStorageLayoutReady,
  SESSION_STORAGE_LAYOUT_VERSION,
} from '../session-layout-guard.js';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}

function tableExists(db: DB, table: string): boolean {
  return Boolean(
    db.prepare(
      `SELECT 1
         FROM sqlite_master
        WHERE type = 'table' AND name = ?`,
    ).get(table),
  );
}

function tableColumns(db: DB, table: string): string[] {
  if (!tableExists(db, table)) return [];
  return (
    db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
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
    columns: tableColumns(db, table.name),
  }));
}

function dependentObjects(
  db: DB,
  table: string,
  column: string,
): Array<{ type: 'index' | 'trigger' | 'view'; name: string; sql: string }> {
  const columnToken = new RegExp(
    `(^|[^a-zA-Z0-9_])${column}([^a-zA-Z0-9_]|$)`,
    'i',
  );
  const tableToken = new RegExp(
    `(^|[^a-zA-Z0-9_])${table}([^a-zA-Z0-9_]|$)`,
    'i',
  );
  return (
    db.prepare(
      `SELECT type, name, sql
         FROM sqlite_master
        WHERE sql IS NOT NULL
          AND ((tbl_name = ? AND type IN ('index', 'trigger')) OR type = 'view')`,
    ).all(table) as Array<{
      type: 'index' | 'trigger' | 'view';
      name: string;
      sql: string;
    }>
  )
    .filter((row) => columnToken.test(row.sql))
    .filter((row) => row.type !== 'view' || tableToken.test(row.sql));
}

function dropMixedColumn(db: DB, table: string, column: string): void {
  if (!tableColumns(db, table).includes(column)) return;
  for (const object of dependentObjects(db, table, column)) {
    if (object.type === 'view') {
      throw new Error(
        `Cannot remove ${table}.${column}: view ${object.name} depends on it`,
      );
    }
    db.exec(
      `DROP ${object.type.toUpperCase()} IF EXISTS ${quoteIdentifier(object.name)}`,
    );
  }
  db.exec(
    `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)}`,
  );
}

function dispositionPredicateIsUsable(
  columns: ReadonlySet<string>,
  disposition: {
    dropColumns?: readonly string[];
    predicateColumns?: readonly string[];
    missingPredicateMeansNoMatch?: boolean;
  },
): boolean {
  const missingPredicateColumns = (disposition.predicateColumns ?? [])
    .filter((column) => !columns.has(column));
  if (missingPredicateColumns.length > 0) {
    if (disposition.missingPredicateMeansNoMatch) return false;
    throw new Error(
      `Cannot evaluate session-row disposition; missing predicate columns: ${
        missingPredicateColumns.join(', ')
      }`,
    );
  }
  return !disposition.dropColumns?.length
    || disposition.dropColumns.some((column) => columns.has(column));
}

function postCutGuardIsUsable(
  db: DB,
  guard: (typeof POST_CUT_ROW_GUARDS)[number],
): boolean {
  const columns = new Set(tableColumns(db, guard.table));
  const required = guard.predicateColumns ?? [];
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length === 0) return true;
  if (
    'missingPredicateMeansNoMatch' in guard &&
    guard.missingPredicateMeansNoMatch
  ) {
    return false;
  }
  throw new Error(
    `Cannot install ${guard.table} session-row guard; missing predicate columns: ${
      missing.join(', ')
    }`,
  );
}

/**
 * Migration 263 is not an exporter. It may finalize a fresh database or the
 * already-clean clone produced by sessions:fs-migrate, but must never erase an
 * initialized legacy database whose bundles were not verified first.
 */
function assertNoLegacySessionRows(db: DB): void {
  const redundant = new Set<string>(REDUNDANT_PROJECTION_TABLES);
  const retiredFeatureTables = new Set(
    TABLE_DISPOSITIONS
      .filter((item) => item.kind === 'drop' && (item.exportOwner === 'sprite' || item.exportOwner === 'design'))
      .map((item) => item.table),
  );
  const populated: string[] = [];
  for (const table of DROP_TABLES) {
    if (!tableExists(db, table) || redundant.has(table) || retiredFeatureTables.has(table)) continue;
    if (db.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`).get()) {
      populated.push(table);
    }
  }
  for (const disposition of DELETE_ROW_DISPOSITIONS) {
    if (!tableExists(db, disposition.table)) continue;
    const columns = new Set(tableColumns(db, disposition.table));
    if (!dispositionPredicateIsUsable(columns, disposition)) continue;
    try {
      if (
        db.prepare(
          `SELECT 1
             FROM ${quoteIdentifier(disposition.table)}
            WHERE ${disposition.whereSql}
            LIMIT 1`,
        ).get()
      ) {
        populated.push(`${disposition.table}[session rows]`);
      }
    } catch (error) {
      throw new Error(
        `Cannot prove ${disposition.table} is free of legacy session rows: ${
          (error as Error).message
        }`,
      );
    }
  }
  if (populated.length > 0) {
    throw new Error(
      'Refusing to remove populated legacy session storage in an application ' +
        `migration (${populated.slice(0, 12).join(', ')}). Run the offline ` +
        '`pnpm sessions:fs-migrate -- --apply --delete-source-db` cutover first.',
    );
  }
}

function installPostCutGuards(db: DB): void {
  for (const guard of POST_CUT_ROW_GUARDS) {
    if (!tableExists(db, guard.table)) continue;
    if (!postCutGuardIsUsable(db, guard)) continue;
    const insertName = `session_fs_reject_${guard.table}_insert`;
    const updateName = `session_fs_reject_${guard.table}_update`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(insertName)}
      BEFORE INSERT ON ${quoteIdentifier(guard.table)}
      WHEN ${guard.insertWhenSql}
      BEGIN
        SELECT RAISE(ABORT, 'session-scoped state belongs in filesystem bundles');
      END;

      CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(updateName)}
      BEFORE UPDATE ON ${quoteIdentifier(guard.table)}
      WHEN ${guard.updateWhenSql}
      BEGIN
        SELECT RAISE(ABORT, 'session-scoped state belongs in filesystem bundles');
      END;
    `);
  }
}

function assertPostCutInvariant(db: DB): void {
  const schemaViolations = findForbiddenSessionSchema(schemaTables(db));
  const rowViolations: string[] = [];
  for (const guard of POST_CUT_ROW_GUARDS) {
    if (!tableExists(db, guard.table)) continue;
    if (!postCutGuardIsUsable(db, guard)) continue;
    if (
      db.prepare(
        `SELECT 1
           FROM ${quoteIdentifier(guard.table)}
          WHERE ${guard.whereSql}
          LIMIT 1`,
      ).get()
    ) {
      rowViolations.push(`forbidden session rows: ${guard.table}`);
    }
  }
  const violations = [...schemaViolations, ...rowViolations];
  if (violations.length > 0) {
    throw new Error(
      `Filesystem-session SQLite invariant failed:\n${violations.join('\n')}`,
    );
  }
}

export const filesystemSessionCutover263: Migration = {
  version: 263,
  name: 'filesystem_session_cutover',
  outsideTransaction: true,
  up(db: DB): void {
    // Project databases reuse the central migration lineage before their
    // schema is trimmed. On a later reopen they no longer contain the
    // central-only app_settings table, but migration 263 must still be able to
    // remove any session schema recreated by the shared bootstrap.
    const ownsGlobalLayoutMarker = tableExists(db, 'app_settings');
    assertNoLegacySessionRows(db);
    db.pragma('foreign_keys = OFF');
    try {
      const transaction = db.transaction(() => {
        for (const disposition of DELETE_ROW_DISPOSITIONS) {
          if (!tableExists(db, disposition.table)) continue;
          const columns = new Set(tableColumns(db, disposition.table));
          if (!dispositionPredicateIsUsable(columns, disposition)) {
            continue;
          }
          db.exec(
            `DELETE FROM ${quoteIdentifier(disposition.table)}
             WHERE ${disposition.whereSql}`,
          );
        }

        for (const disposition of DELETE_ROW_DISPOSITIONS) {
          if (!tableExists(db, disposition.table)) continue;
          for (const column of disposition.dropColumns ?? []) {
            dropMixedColumn(db, disposition.table, column);
          }
        }

        for (const table of REDUNDANT_PROJECTION_TABLES) {
          db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
        }
        const redundant = new Set<string>(REDUNDANT_PROJECTION_TABLES);
        for (const table of [...DROP_TABLES].reverse()) {
          if (redundant.has(table)) continue;
          db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
        }

        installPostCutGuards(db);
        if (ownsGlobalLayoutMarker) {
          markSessionStorageLayoutReady(db);
        }
        assertPostCutInvariant(db);
        const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
        if (foreignKeyViolations.length > 0) {
          throw new Error(
            `foreign_key_check found ${foreignKeyViolations.length} violation(s)`,
          );
        }
      });
      transaction();
    } finally {
      db.pragma('foreign_keys = ON');
    }

    if (ownsGlobalLayoutMarker) {
      const marker = db.prepare(
        `SELECT value FROM app_settings WHERE key = 'session_storage_layout_version'`,
      ).get() as { value?: string } | undefined;
      if (marker?.value !== SESSION_STORAGE_LAYOUT_VERSION) {
        throw new Error('Filesystem session layout marker was not committed');
      }
    }
    assertPostCutInvariant(db);
  },
};
