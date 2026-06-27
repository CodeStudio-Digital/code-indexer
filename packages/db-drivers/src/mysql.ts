/**
 * MySQL / MariaDB driver (`mysql2/promise`, pure JS — already a root dependency).
 *
 * MariaDB rides the same wire protocol. Cancellation: the query runs on a
 * dedicated pooled connection whose threadId is captured; on `signal.abort` a
 * side connection issues `KILL QUERY <threadId>`. Rows are capped by `maxRows`.
 * For MySQL a "schema" is a database, so `listSchemas` returns the database.
 */
import { DEFAULT_MAX_ROWS } from './types.js';
import { buildTablePreview } from './sql/preview.js';
import type {
  ColumnInfo,
  DatabaseDriver,
  DbConnectConfig,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RunQueryOptions,
  TableInfo,
  TableRef,
} from './types.js';

interface MysqlConn {
  threadId: number;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  release(): void;
  destroy(): void;
}
interface MysqlPool {
  getConnection(): Promise<MysqlConn>;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function buildPoolConfig(config: DbConnectConfig): Record<string, unknown> {
  const opts = config.options ?? {};
  const extra: Record<string, unknown> = { connectionLimit: 3 };
  if (typeof opts.connectTimeoutMs === 'number') extra.connectTimeout = opts.connectTimeoutMs;
  if (config.connectionString) return { uri: config.connectionString, ...extra };
  return {
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    ...(sslConfig(config) ? { ssl: sslConfig(config) } : {}),
    ...extra,
  };
}

function sslConfig(config: DbConnectConfig): Record<string, unknown> | undefined {
  const mode = config.ssl?.mode;
  if (!mode || mode === 'disable') return undefined;
  // MySQL (unlike libpq) verifies the server cert under REQUIRED — keep that
  // guarantee so 'require' isn't a silent MITM downgrade. Use verify-ca/-full
  // with a CA for self-signed servers.
  return { rejectUnauthorized: true, ca: config.ssl?.ca, cert: config.ssl?.cert, key: config.ssl?.key };
}

export async function createMysqlDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  const mysql = (await import('mysql2/promise')) as unknown as {
    createPool(c: unknown): MysqlPool;
  };
  const pool = mysql.createPool(buildPoolConfig(config));

  async function runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const conn = await pool.getConnection();
    let onAbort: (() => void) | null = null;
    try {
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        const threadId = Number(conn.threadId);
        onAbort = (): void => {
          pool.query(`KILL QUERY ${threadId}`).catch(() => void 0);
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      // Schema-scoped console (schema == database in MySQL): switch on THIS conn only.
      if (opts.schema) {
        await conn.query(`USE ${qIdent(opts.schema)}`);
      }
      const [rows, fields] = await conn.query(sql, opts.params);
      if (Array.isArray(rows)) {
        const arr = rows as Array<Record<string, unknown>>;
        const truncated = arr.length > max;
        return {
          rows: truncated ? arr.slice(0, max) : arr,
          rowCount: arr.length,
          fields: Array.isArray(fields)
            ? (fields as Array<{ name: string }>).map((f) => ({ name: f.name }))
            : [],
          truncated,
        };
      }
      const ok = rows as { affectedRows?: number };
      return { rows: [], rowCount: ok.affectedRows ?? 0, fields: [], command: 'OK' };
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      // A `USE <schema>` switch must not leak to the next pooled borrower. Restore
      // the connection's known default db; if there's none to restore to (or the
      // restore fails), DESTROY the connection instead of releasing it dirty.
      if (opts.schema) {
        if (config.database) {
          try {
            await conn.query(`USE ${qIdent(config.database)}`);
            conn.release();
          } catch {
            conn.destroy();
          }
        } else {
          conn.destroy();
        }
      } else {
        conn.release();
      }
    }
  }

  async function poolRows<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const [rows] = await pool.query(sql, params);
    return Array.isArray(rows) ? (rows as T[]) : [];
  }

  async function describeTable(schemaName: string, name: string): Promise<TableInfo> {
    const cols = await poolRows<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      COLUMN_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_KEY: string;
      COLUMN_DEFAULT: string | null;
      EXTRA: string;
      ORDINAL_POSITION: number;
      CHARACTER_MAXIMUM_LENGTH: number | null;
      NUMERIC_PRECISION: number | null;
      COLUMN_COMMENT: string | null;
    }>(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA,
              ORDINAL_POSITION, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, COLUMN_COMMENT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [schemaName, name],
    );
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: c.COLUMN_NAME,
      dataType: c.COLUMN_TYPE || c.DATA_TYPE,
      nullable: c.IS_NULLABLE === 'YES',
      isPrimaryKey: c.COLUMN_KEY === 'PRI',
      isAutoIncrement: /auto_increment/i.test(c.EXTRA),
      defaultValue: c.COLUMN_DEFAULT,
      ordinal: c.ORDINAL_POSITION,
      charMaxLength: c.CHARACTER_MAXIMUM_LENGTH,
      numericPrecision: c.NUMERIC_PRECISION,
      comment: c.COLUMN_COMMENT,
    }));

    const idxRows = await poolRows<{
      INDEX_NAME: string;
      NON_UNIQUE: number;
      COLUMN_NAME: string;
    }>(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schemaName, name],
    );
    const indexes = groupIndexes(idxRows);

    const fkRows = await poolRows<{
      CONSTRAINT_NAME: string;
      COLUMN_NAME: string;
      REFERENCED_TABLE_SCHEMA: string;
      REFERENCED_TABLE_NAME: string;
      REFERENCED_COLUMN_NAME: string;
    }>(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [schemaName, name],
    );
    const refRules = await poolRows<{ CONSTRAINT_NAME: string; DELETE_RULE: string; UPDATE_RULE: string }>(
      `SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE
         FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
      [schemaName, name],
    );
    const ruleByName = new Map(refRules.map((r) => [r.CONSTRAINT_NAME, r]));
    const foreignKeys = groupForeignKeys(fkRows, ruleByName);

    return { schema: schemaName, name, kind: 'table', columns, indexes, foreignKeys };
  }

  const driver: DatabaseDriver = {
    kind: 'relational',
    async testConnection() {
      const rows = await poolRows<{ v: string }>('SELECT VERSION() AS v');
      return { serverVersion: rows[0]?.v };
    },
    async listDatabases() {
      const rows = await poolRows<{ Database: string }>('SHOW DATABASES');
      return rows.map((r) => r.Database).filter((d) => !SYSTEM_DBS.has(d));
    },
    async listSchemas(database) {
      if (database) return [database];
      return driver.listDatabases();
    },
    async listTables(schemaName) {
      const target = schemaName ?? config.database;
      const rows = await poolRows<{ TABLE_NAME: string; TABLE_TYPE: string }>(
        `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ${target ? '?' : 'DATABASE()'} ORDER BY TABLE_NAME`,
        target ? [target] : [],
      );
      return rows.map((r) => ({
        schema: target ?? '',
        name: r.TABLE_NAME,
        kind: r.TABLE_TYPE === 'VIEW' ? ('view' as const) : ('table' as const),
      })) satisfies TableRef[];
    },
    describeTable,
    async listObjects(kind, schemaName, table) {
      const target = schemaName || config.database;
      if (kind === 'sequences') return []; // MySQL has no sequences
      if (kind === 'triggers') {
        const rows = await poolRows<{ TRIGGER_NAME: string }>(
          `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
            WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`,
          [target, table ?? ''],
        );
        return rows.map((r) => r.TRIGGER_NAME);
      }
      const rows = await poolRows<{ ROUTINE_NAME: string }>(
        `SELECT ROUTINE_NAME FROM information_schema.ROUTINES
          WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
        [target],
      );
      return rows.map((r) => r.ROUTINE_NAME);
    },
    tablePreview(schemaName, name, opts) {
      const target = schemaName || config.database;
      const rel = target ? `${qIdent(target)}.${qIdent(name)}` : qIdent(name);
      const { sql, params } = buildTablePreview('mysql', rel, opts);
      return runQuery(sql, { params, maxRows: opts.limit });
    },
    async schema(schemaName) {
      const tables = await driver.listTables(schemaName);
      const out: TableInfo[] = [];
      for (const t of tables) out.push(await describeTable(t.schema, t.name));
      return out;
    },
    runQuery,
    query(sql, params) {
      return runQuery(sql, { params });
    },
    async close() {
      await pool.end();
    },
  };
  return driver;
}

/** MySQL identifier quoting: wrap in backticks, escaping embedded backticks. */
function qIdent(s: string): string {
  return `\`${s.replace(/`/g, '``')}\``;
}

function groupIndexes(rows: Array<{ INDEX_NAME: string; NON_UNIQUE: number; COLUMN_NAME: string }>): IndexInfo[] {
  const map = new Map<string, IndexInfo>();
  for (const r of rows) {
    let idx = map.get(r.INDEX_NAME);
    if (!idx) {
      idx = {
        name: r.INDEX_NAME,
        columns: [],
        unique: Number(r.NON_UNIQUE) === 0,
        primary: r.INDEX_NAME === 'PRIMARY',
      };
      map.set(r.INDEX_NAME, idx);
    }
    idx.columns.push(r.COLUMN_NAME);
  }
  return [...map.values()];
}

function groupForeignKeys(
  rows: Array<{
    CONSTRAINT_NAME: string;
    COLUMN_NAME: string;
    REFERENCED_TABLE_SCHEMA: string;
    REFERENCED_TABLE_NAME: string;
    REFERENCED_COLUMN_NAME: string;
  }>,
  rules: Map<string, { DELETE_RULE: string; UPDATE_RULE: string }>,
): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    let fk = map.get(r.CONSTRAINT_NAME);
    if (!fk) {
      const rule = rules.get(r.CONSTRAINT_NAME);
      fk = {
        name: r.CONSTRAINT_NAME,
        columns: [],
        refSchema: r.REFERENCED_TABLE_SCHEMA,
        refTable: r.REFERENCED_TABLE_NAME,
        refColumns: [],
        onDelete: rule?.DELETE_RULE,
        onUpdate: rule?.UPDATE_RULE,
      };
      map.set(r.CONSTRAINT_NAME, fk);
    }
    fk.columns.push(r.COLUMN_NAME);
    fk.refColumns.push(r.REFERENCED_COLUMN_NAME);
  }
  return [...map.values()];
}
