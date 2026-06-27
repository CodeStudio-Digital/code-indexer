/**
 * SQL Server driver (`mssql` / Tedious, pure JS).
 *
 * Cancellation: each query runs on a fresh pooled `request`; on `signal.abort`
 * we call `request.cancel()`. Parameters bind as `@p0,@p1…` (see `placeholder`).
 * Pagination uses `OFFSET … ROWS FETCH NEXT … ROWS ONLY` (needs an ORDER BY, so
 * `tablePreview` orders by `(SELECT NULL)`). Identifier quoting is `[name]`.
 *
 * NOTE: written against the SQL Server system catalogs but NOT yet verified
 * against a live server — exercise with a real instance before trusting writes.
 */
import { DEFAULT_MAX_ROWS } from './types.js';
import { quoteRelation } from './sql/identifiers.js';
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

interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query(sql: string): Promise<{ recordset?: Array<Record<string, unknown>> & { columns?: Record<string, unknown> }; rowsAffected?: number[] }>;
  cancel(): void;
}
interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(): MssqlRequest;
  close(): Promise<void>;
}

const SYSTEM_SCHEMAS = new Set(['sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin', 'db_backupoperator', 'db_datareader', 'db_datawriter', 'db_denydatareader', 'db_denydatawriter']);

function buildPoolConfig(config: DbConnectConfig): Record<string, unknown> {
  const opts = config.options ?? {};
  const mode = config.ssl?.mode;
  const base: Record<string, unknown> = {
    server: config.host ?? 'localhost',
    port: config.port ?? 1433,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    pool: { max: 3, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      // Azure/modern SQL Server default to encrypted; trust self-signed unless a
      // CA is supplied (verify-ca/-full keep the check on).
      encrypt: mode !== 'disable',
      trustServerCertificate: mode === 'require' || !mode,
    },
    connectionTimeout: typeof opts.connectTimeoutMs === 'number' ? opts.connectTimeoutMs : 10_000,
  };
  return base;
}

export async function createMssqlDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  const mssql = (await import('mssql')) as unknown as {
    ConnectionPool: new (c: unknown) => MssqlPool;
  };
  // node-mssql only parses a connection string when it's passed as a bare STRING
  // (an object's `connectionString` property is ignored, unlike pg/mysql2). So in
  // URL mode hand the string straight to the pool; otherwise build the config object.
  const poolInput: unknown = config.connectionString ? config.connectionString : buildPoolConfig(config);
  const pool = await new mssql.ConnectionPool(poolInput).connect();

  async function runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const request = pool.request();
    let onAbort: (() => void) | null = null;
    try {
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        onAbort = (): void => request.cancel();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      (opts.params ?? []).forEach((p, i) => request.input(`p${i}`, p ?? null));
      const result = await request.query(sql);
      const rs = result.recordset;
      if (rs) {
        const arr = rs as Array<Record<string, unknown>>;
        const truncated = arr.length > max;
        const fields = rs.columns
          ? Object.keys(rs.columns).map((name) => ({ name }))
          : arr[0]
            ? Object.keys(arr[0]).map((name) => ({ name }))
            : [];
        return { rows: truncated ? arr.slice(0, max) : arr, rowCount: arr.length, fields, truncated };
      }
      const affected = Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((a, b) => a + b, 0) : 0;
      return { rows: [], rowCount: affected, fields: [], command: 'OK' };
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
  }

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await runQuery(sql, { params, maxRows: 100_000 });
    return r.rows as T[];
  }

  async function describeTable(schemaName: string, name: string): Promise<TableInfo> {
    const cols = await rows<{
      COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: number; COLUMN_DEFAULT: string | null;
      ORD: number; CHAR_LEN: number | null; NUM_PREC: number | null; IS_IDENTITY: number;
    }>(
      `SELECT col.name AS COLUMN_NAME, t.name AS DATA_TYPE, col.is_nullable AS IS_NULLABLE,
              dc.definition AS COLUMN_DEFAULT, col.column_id AS ORD,
              col.max_length AS CHAR_LEN, col.precision AS NUM_PREC, col.is_identity AS IS_IDENTITY
         FROM sys.columns col
         JOIN sys.objects o ON o.object_id = col.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.types t ON t.user_type_id = col.user_type_id
         LEFT JOIN sys.default_constraints dc ON dc.object_id = col.default_object_id
        WHERE s.name = @p0 AND o.name = @p1
        ORDER BY col.column_id`,
      [schemaName, name],
    );
    const idxRows = await rows<{ INDEX_NAME: string; IS_UNIQUE: number; IS_PRIMARY: number; COLUMN_NAME: string }>(
      `SELECT i.name AS INDEX_NAME, i.is_unique AS IS_UNIQUE, i.is_primary_key AS IS_PRIMARY, c.name AS COLUMN_NAME
         FROM sys.indexes i
         JOIN sys.objects o ON o.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE s.name = @p0 AND o.name = @p1 AND i.name IS NOT NULL
        ORDER BY i.name, ic.key_ordinal`,
      [schemaName, name],
    );
    const pkCols = new Set(idxRows.filter((r) => Number(r.IS_PRIMARY) === 1).map((r) => r.COLUMN_NAME));
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: c.COLUMN_NAME,
      dataType: c.DATA_TYPE,
      nullable: Number(c.IS_NULLABLE) === 1,
      isPrimaryKey: pkCols.has(c.COLUMN_NAME),
      isAutoIncrement: Number(c.IS_IDENTITY) === 1,
      defaultValue: c.COLUMN_DEFAULT,
      ordinal: c.ORD,
      charMaxLength: c.CHAR_LEN,
      numericPrecision: c.NUM_PREC,
    }));
    const indexes = groupIndexes(idxRows);

    const fkRows = await rows<{
      FK_NAME: string; COLUMN_NAME: string; REF_SCHEMA: string; REF_TABLE: string; REF_COLUMN: string;
      DELETE_RULE: string; UPDATE_RULE: string;
    }>(
      `SELECT fk.name AS FK_NAME, pc.name AS COLUMN_NAME, rs.name AS REF_SCHEMA, rt.name AS REF_TABLE, rc.name AS REF_COLUMN,
              fk.delete_referential_action_desc AS DELETE_RULE, fk.update_referential_action_desc AS UPDATE_RULE
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.objects o ON o.object_id = fk.parent_object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.columns pc ON pc.object_id = fk.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN sys.columns rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE s.name = @p0 AND o.name = @p1
        ORDER BY fk.name, fkc.constraint_column_id`,
      [schemaName, name],
    );
    const foreignKeys = groupForeignKeys(fkRows);

    return { schema: schemaName, name, kind: 'table', columns, indexes, foreignKeys };
  }

  const driver: DatabaseDriver = {
    kind: 'relational',
    async testConnection() {
      const r = await rows<{ v: string }>('SELECT @@VERSION AS v');
      return { serverVersion: r[0]?.v };
    },
    async listDatabases() {
      const r = await rows<{ name: string }>('SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name');
      return r.map((x) => x.name);
    },
    async listSchemas() {
      const r = await rows<{ name: string }>('SELECT name FROM sys.schemas ORDER BY name');
      return r.map((x) => x.name).filter((s) => !SYSTEM_SCHEMAS.has(s));
    },
    async listTables(schemaName) {
      const r = await rows<{ TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string }>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = @p0 ORDER BY TABLE_NAME`,
        [schemaName ?? 'dbo'],
      );
      return r.map((x) => ({
        schema: x.TABLE_SCHEMA,
        name: x.TABLE_NAME,
        kind: x.TABLE_TYPE === 'VIEW' ? ('view' as const) : ('table' as const),
      })) satisfies TableRef[];
    },
    describeTable,
    async listObjects(kind, schemaName, table) {
      const schema = schemaName ?? 'dbo';
      if (kind === 'sequences') {
        const r = await rows<{ name: string }>(
          `SELECT seq.name AS name FROM sys.sequences seq JOIN sys.schemas s ON s.schema_id = seq.schema_id
            WHERE s.name = @p0 ORDER BY seq.name`,
          [schema],
        );
        return r.map((x) => x.name);
      }
      if (kind === 'triggers') {
        const r = await rows<{ name: string }>(
          `SELECT tr.name AS name FROM sys.triggers tr
            JOIN sys.objects o ON o.object_id = tr.parent_id
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE s.name = @p0 AND o.name = @p1 ORDER BY tr.name`,
          [schema, table ?? ''],
        );
        return r.map((x) => x.name);
      }
      const r = await rows<{ name: string }>(
        `SELECT o.name AS name FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @p0 AND o.type IN ('FN','IF','TF','P') ORDER BY o.name`,
        [schema],
      );
      return r.map((x) => x.name);
    },
    tablePreview(schemaName, name, opts) {
      const rel = quoteRelation('mssql', schemaName || 'dbo', name);
      const { sql, params } = buildTablePreview('mssql', rel, opts);
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
      await pool.close();
    },
  };
  return driver;
}

function groupIndexes(rows: Array<{ INDEX_NAME: string; IS_UNIQUE: number; IS_PRIMARY: number; COLUMN_NAME: string }>): IndexInfo[] {
  const map = new Map<string, IndexInfo>();
  for (const r of rows) {
    let idx = map.get(r.INDEX_NAME);
    if (!idx) {
      idx = { name: r.INDEX_NAME, columns: [], unique: Number(r.IS_UNIQUE) === 1, primary: Number(r.IS_PRIMARY) === 1 };
      map.set(r.INDEX_NAME, idx);
    }
    idx.columns.push(r.COLUMN_NAME);
  }
  return [...map.values()];
}

function groupForeignKeys(
  rows: Array<{ FK_NAME: string; COLUMN_NAME: string; REF_SCHEMA: string; REF_TABLE: string; REF_COLUMN: string; DELETE_RULE: string; UPDATE_RULE: string }>,
): ForeignKeyInfo[] {
  const norm = (s: string): string => s.replace(/_/g, ' ');
  const map = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    let fk = map.get(r.FK_NAME);
    if (!fk) {
      fk = {
        name: r.FK_NAME, columns: [], refSchema: r.REF_SCHEMA, refTable: r.REF_TABLE, refColumns: [],
        onDelete: norm(r.DELETE_RULE), onUpdate: norm(r.UPDATE_RULE),
      };
      map.set(r.FK_NAME, fk);
    }
    fk.columns.push(r.COLUMN_NAME);
    fk.refColumns.push(r.REF_COLUMN);
  }
  return [...map.values()];
}
