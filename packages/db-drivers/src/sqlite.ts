/**
 * SQLite driver (better-sqlite3 — native, but ALREADY the store's binary, so it
 * is electron:rebuild-ed once for the whole app). Synchronous + local + fast, so
 * results are capped by `maxRows` and cancellation is a no-op (a giant scan would
 * move to a worker in P4). Introspection uses the `pragma_*` table-valued
 * functions so the table name is bound, never string-interpolated.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { DEFAULT_MAX_ROWS } from './types.js';
import { buildTablePreview } from './sql/preview.js';
import type {
  ColumnInfo,
  DatabaseDriver,
  DbConnectConfig,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RunBatchOptions,
  RunQueryOptions,
  TableInfo,
  TableRef,
} from './types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export function createSqliteDriver(config: DbConnectConfig): DatabaseDriver {
  const filePath = config.filePath ?? config.database ?? config.connectionString;
  if (!filePath) throw new Error('sqlite: filePath is required');
  const db: DB = new Database(filePath, { readonly: false, fileMustExist: false });

  /** Run ONE statement synchronously, returning a capped QueryResult. */
  function execStatement(sql: string, params: unknown[], max: number): QueryResult {
    try {
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        const all = stmt.all(...params) as Array<Record<string, unknown>>;
        const truncated = all.length > max;
        const fields = (stmt.columns() as Array<{ name: string }>).map((c) => ({ name: c.name }));
        return { rows: truncated ? all.slice(0, max) : all, rowCount: all.length, fields, truncated };
      }
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes, fields: [], command: 'OK' };
    } catch (err) {
      // better-sqlite3 can't prepare multiple statements — its real message is
      // "...contains more than one statement..." — fall back to exec (no rows).
      if (err instanceof Error && /more than one statement|multiple statements|cannot.*prepare/i.test(err.message)) {
        db.exec(sql);
        return { rows: [], rowCount: 0, fields: [], command: 'OK' };
      }
      throw err;
    }
  }

  function runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    try {
      return Promise.resolve(execStatement(sql, (opts.params ?? []) as unknown[], max));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function runBatch(statements: string[], opts: RunBatchOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    // One synchronous db handle (no pool to hop), but wrap the list in an explicit
    // transaction so a mid-list failure rolls back instead of leaving a partial apply.
    let inTxn = false;
    try {
      db.exec('BEGIN');
      inTxn = true;
      let last: QueryResult = { rows: [], rowCount: 0, fields: [] };
      for (const stmt of statements) last = execStatement(stmt, [], max);
      db.exec('COMMIT');
      inTxn = false;
      return Promise.resolve(last);
    } catch (err) {
      if (inTxn) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* nothing open to roll back */
        }
      }
      return Promise.reject(err);
    }
  }

  function describeTable(_schema: string, name: string): Promise<TableInfo> {
    const cols = db
      .prepare('SELECT * FROM pragma_table_info(?)')
      .all(name) as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
    // Only a table declared with AUTOINCREMENT is truly auto-increment; a plain
    // INTEGER PRIMARY KEY is just the rowid alias. Read the actual DDL to tell.
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { sql?: string }
      | undefined)?.sql ?? '';
    const hasAutoInc = /\bAUTOINCREMENT\b/i.test(ddl);
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: c.name,
      dataType: c.type || 'BLOB',
      nullable: c.notnull === 0,
      isPrimaryKey: c.pk > 0,
      isAutoIncrement: hasAutoInc && c.pk > 0 && /^integer$/i.test(c.type),
      defaultValue: c.dflt_value == null ? null : String(c.dflt_value),
      ordinal: c.cid + 1,
    }));

    const idxList = db
      .prepare('SELECT * FROM pragma_index_list(?)')
      .all(name) as Array<{ name: string; unique: number; origin: string }>;
    const indexes: IndexInfo[] = idxList.map((ix) => {
      const cols2 = db
        .prepare('SELECT * FROM pragma_index_info(?)')
        .all(ix.name) as Array<{ name: string }>;
      return {
        name: ix.name,
        columns: cols2.map((c) => c.name),
        unique: ix.unique === 1,
        primary: ix.origin === 'pk',
      };
    });

    const fkList = db
      .prepare('SELECT * FROM pragma_foreign_key_list(?)')
      .all(name) as Array<{ id: number; table: string; from: string; to: string; on_update: string; on_delete: string }>;
    const fkMap = new Map<number, ForeignKeyInfo>();
    for (const fk of fkList) {
      let entry = fkMap.get(fk.id);
      if (!entry) {
        entry = {
          name: `fk_${name}_${fk.id}`,
          columns: [],
          refTable: fk.table,
          refColumns: [],
          onDelete: fk.on_delete,
          onUpdate: fk.on_update,
        };
        fkMap.set(fk.id, entry);
      }
      entry.columns.push(fk.from);
      entry.refColumns.push(fk.to);
    }

    return Promise.resolve({ schema: 'main', name, kind: 'table', columns, indexes, foreignKeys: [...fkMap.values()] });
  }

  const driver: DatabaseDriver = {
    kind: 'relational',
    testConnection() {
      const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      return Promise.resolve({ serverVersion: `SQLite ${row.v}` });
    },
    listDatabases() {
      const rows = db.pragma('database_list') as Array<{ name: string }>;
      return Promise.resolve(rows.map((r) => r.name));
    },
    listSchemas() {
      return Promise.resolve(['main']);
    },
    listTables() {
      const rows = db
        .prepare(
          `SELECT name, type FROM sqlite_master
            WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
        )
        .all() as Array<{ name: string; type: string }>;
      return Promise.resolve(
        rows.map((r) => ({ schema: 'main', name: r.name, kind: r.type === 'view' ? ('view' as const) : ('table' as const) })) satisfies TableRef[],
      );
    },
    describeTable,
    listObjects(kind, _schema, table) {
      if (kind !== 'triggers') return Promise.resolve([]); // sqlite has no functions/sequences
      const rows = (table
        ? db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(table)
        : db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).all()) as Array<{ name: string }>;
      return Promise.resolve(rows.map((r) => r.name));
    },
    tablePreview(_schema, name, opts) {
      const rel = `"${name.replace(/"/g, '""')}"`;
      const { sql, params } = buildTablePreview('sqlite', rel, opts);
      return runQuery(sql, { params, maxRows: opts.limit });
    },
    async schema() {
      const tables = await driver.listTables();
      const out: TableInfo[] = [];
      for (const t of tables) out.push(await describeTable('main', t.name));
      return out;
    },
    runQuery,
    runBatch,
    query(sql, params) {
      return runQuery(sql, { params });
    },
    close() {
      db.close();
      return Promise.resolve();
    },
  };
  return driver;
}
