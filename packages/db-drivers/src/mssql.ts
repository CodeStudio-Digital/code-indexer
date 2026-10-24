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
import { assertDatabaseDispatch } from './dispatch.js';
import { quoteRelation } from './sql/identifiers.js';
import { buildTablePreview } from './sql/preview.js';
import type {
  ColumnInfo,
  DatabaseDriver,
  DbConnectConfig,
  ForeignKeyInfo,
  IncomingForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RunBatchOptions,
  RunBatchStatement,
  RunQueryOptions,
  TableInfo,
  TableRef,
} from './types.js';

interface MssqlQueryOutput {
  recordset?: Array<Record<string, unknown>> & { columns?: Record<string, unknown> };
  rowsAffected?: number[];
}
interface MssqlRequestOverrides {
  requestTimeout?: number;
}
interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query(sql: string): Promise<MssqlQueryOutput>;
  cancel(): void;
}
interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(overrides?: MssqlRequestOverrides): MssqlRequest;
  close(): Promise<void>;
}
/** node-mssql Transaction — drives an explicit BEGIN/COMMIT on one connection. */
interface MssqlTransaction {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface MssqlApi {
  ConnectionPool: new (c: unknown) => MssqlPool;
  Transaction: new (pool: MssqlPool) => MssqlTransaction;
  Request: new (txn: MssqlTransaction, overrides?: MssqlRequestOverrides) => MssqlRequest;
}

/** node-mssql reads per-request deadlines only from the creation overrides. */
export function mssqlRequestOverrides(timeoutMs: number | undefined): MssqlRequestOverrides | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return { requestTimeout: Math.trunc(timeoutMs) };
}

/**
 * `mssql` is CommonJS. Native Node ESM exposes its API under `default`, while
 * some bundlers synthesize named exports. Accept both shapes so the driver
 * behaves the same in tests, the HTTP process and packaged Electron builds.
 */
export function normalizeMssqlModule(module: unknown): MssqlApi {
  const namespace = module as Partial<MssqlApi> & { default?: Partial<MssqlApi> };
  const candidate = typeof namespace.ConnectionPool === 'function' ? namespace : namespace.default;
  if (
    !candidate ||
    typeof candidate.ConnectionPool !== 'function' ||
    typeof candidate.Transaction !== 'function' ||
    typeof candidate.Request !== 'function'
  ) {
    throw new TypeError('mssql module did not expose ConnectionPool, Transaction and Request constructors');
  }
  return candidate as MssqlApi;
}

const SYSTEM_SCHEMAS = new Set(['sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin', 'db_backupoperator', 'db_datareader', 'db_datawriter', 'db_denydatareader', 'db_denydatawriter']);

/** Reconstruct the declared SQL Server type from sys.columns metadata. */
export function formatMssqlType(
  type: string,
  maxLength: number | null,
  precision: number | null,
  scale: number | null,
): string {
  const lower = type.toLowerCase();
  if (lower === 'varchar' || lower === 'char' || lower === 'varbinary' || lower === 'binary') {
    const length = maxLength === -1 ? 'max' : String(maxLength ?? 1);
    return `${type}(${length})`;
  }
  if (lower === 'nvarchar' || lower === 'nchar') {
    const length = maxLength === -1 ? 'max' : String(Math.max(1, Math.trunc((maxLength ?? 2) / 2)));
    return `${type}(${length})`;
  }
  if (lower === 'decimal' || lower === 'numeric') {
    return `${type}(${precision ?? 18},${scale ?? 0})`;
  }
  if (lower === 'datetime2' || lower === 'datetimeoffset' || lower === 'time') {
    return `${type}(${scale ?? 7})`;
  }
  if (lower === 'float' && precision != null) return `${type}(${precision})`;
  return type;
}

function mssqlCharacterLength(type: string, maxLength: number | null): number | null {
  const lower = type.toLowerCase();
  if (lower === 'nvarchar' || lower === 'nchar') {
    return maxLength === -1 ? -1 : Math.trunc((maxLength ?? 0) / 2);
  }
  if (lower === 'varchar' || lower === 'char') return maxLength;
  return null;
}

function buildPoolConfig(config: DbConnectConfig): Record<string, unknown> {
  const opts = config.options ?? {};
  const mode = config.ssl?.mode;
  const ssl = config.ssl;
  const options: Record<string, unknown> = {
    // Azure/modern SQL Server default to encrypted; trust self-signed unless a
    // CA is supplied (verify-ca/-full keep the check on).
    encrypt: mode !== 'disable',
    trustServerCertificate: mode === 'require' || !mode,
  };
  // Honor a user-supplied CA/cert/key (verify-ca/verify-full) — Tedious feeds
  // cryptoCredentialsDetails to Node's tls.createSecureContext.
  if (ssl?.ca || ssl?.cert || ssl?.key) {
    options.cryptoCredentialsDetails = { ca: ssl.ca, cert: ssl.cert, key: ssl.key };
  }
  if (typeof opts.applicationName === 'string' && opts.applicationName) {
    options.appName = opts.applicationName;
  }
  return {
    server: config.host ?? 'localhost',
    port: config.port ?? 1433,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    pool: { max: 3, min: 0, idleTimeoutMillis: 30_000 },
    options,
    connectionTimeout: typeof opts.connectTimeoutMs === 'number' ? opts.connectTimeoutMs : 10_000,
  };
}

export async function createMssqlDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  const mssql = normalizeMssqlModule(await import('mssql'));
  // node-mssql only parses a connection string when it's passed as a bare STRING
  // (an object's `connectionString` property is ignored, unlike pg/mysql2). So in
  // URL mode hand the string straight to the pool; otherwise build the config object.
  const poolInput: unknown = config.connectionString ? config.connectionString : buildPoolConfig(config);
  const pool = await new mssql.ConnectionPool(poolInput).connect();

  async function runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
    assertDatabaseDispatch(opts);
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    // SQL Server has no per-session `SET TRANSACTION READ ONLY`. For a saved
    // read-only connection, execute inside a pinned transaction and always roll
    // it back. The shared factory classifier still rejects writes before this.
    const txn = config.readOnly ? new mssql.Transaction(pool) : null;
    let inTxn = false;
    let onAbort: (() => void) | null = null;
    try {
      if (txn) {
        await txn.begin();
        inTxn = true;
      }
      // node-mssql defaults to 15 seconds. Its Request instance reads a
      // per-query override ONLY at construction, under `requestTimeout`.
      // Supplying it here keeps the console setting isolated to this statement.
      const overrides = mssqlRequestOverrides(opts.timeoutMs);
      const request: MssqlRequest = txn ? new mssql.Request(txn, overrides) : pool.request(overrides);
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        onAbort = (): void => request.cancel();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      (opts.params ?? []).forEach((p, i) => request.input(`p${i}`, p ?? null));
      assertDatabaseDispatch(opts);
      const result = shapeMssqlResult(await request.query(sql), max);
      if (txn && inTxn) {
        await txn.rollback();
        inTxn = false;
      }
      return result;
    } catch (err) {
      if (txn && inTxn) {
        await txn.rollback().catch(() => void 0);
        inTxn = false;
      }
      throw err;
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
  }

  async function runBatch(statements: RunBatchStatement[], opts: RunBatchOptions = {}): Promise<QueryResult> {
    if (config.readOnly) throw new Error('Connection is read-only — batch execution is blocked.');
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    // A node-mssql Transaction pins a single connection for begin→commit; every
    // Request built from it runs there. SQL Server rolls back DDL too, so a
    // mid-batch failure undoes the whole list (unlike MySQL/Oracle).
    const txn = new mssql.Transaction(pool);
    let onAbort: (() => void) | null = null;
    let current: MssqlRequest | null = null;
    let inTxn = false;
    try {
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        onAbort = (): void => {
          try {
            current?.cancel();
          } catch {
            /* no request in flight */
          }
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      await txn.begin();
      inTxn = true;
      let last: QueryResult = { rows: [], rowCount: 0, fields: [] };
      for (let index = 0; index < statements.length; index += 1) {
        const stmt = statements[index];
        const request = new mssql.Request(txn);
        current = request;
        if (typeof stmt !== 'string') {
          (stmt.params ?? []).forEach((param, paramIndex) => request.input(`p${paramIndex}`, param ?? null));
        }
        last = shapeMssqlResult(await request.query(typeof stmt === 'string' ? stmt : stmt.sql), max);
        opts.onResult?.(last, index);
      }
      await txn.commit();
      inTxn = false;
      return last;
    } catch (err) {
      if (inTxn) await txn.rollback().catch(() => void 0);
      throw err;
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
  }

  async function explainQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
    const txn = new mssql.Transaction(pool);
    let inTxn = false;
    let showplan = false;
    let current: MssqlRequest | null = null;
    const cancel = (): void => current?.cancel();
    try {
      if (opts.signal?.aborted) throw new Error('query cancelled');
      opts.signal?.addEventListener('abort', cancel, { once: true });
      await txn.begin();
      inTxn = true;
      current = new mssql.Request(txn, mssqlRequestOverrides(opts.timeoutMs));
      await current.query('SET SHOWPLAN_XML ON');
      showplan = true;
      current = new mssql.Request(txn, mssqlRequestOverrides(opts.timeoutMs));
      const result = shapeMssqlResult(await current.query(sql), opts.maxRows ?? DEFAULT_MAX_ROWS);
      current = new mssql.Request(txn);
      await current.query('SET SHOWPLAN_XML OFF');
      showplan = false;
      await txn.rollback();
      inTxn = false;
      return result;
    } catch (error) {
      // SHOWPLAN is session state. Always turn it off before this pinned
      // connection can return to the pool, even when compilation/cancel fails.
      if (showplan) {
        try {
          current = new mssql.Request(txn);
          await current.query('SET SHOWPLAN_XML OFF');
        } catch {
          /* rollback/connection disposal below is the remaining containment */
        }
      }
      if (inTxn) await txn.rollback().catch(() => void 0);
      throw error;
    } finally {
      opts.signal?.removeEventListener('abort', cancel);
    }
  }

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await runQuery(sql, { params, maxRows: 100_000 });
    return r.rows as T[];
  }

  async function describeTable(schemaName: string, name: string): Promise<TableInfo> {
    const schema = schemaName || 'dbo';
    const cols = await rows<{
      COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: number; COLUMN_DEFAULT: string | null;
      ORD: number; CHAR_LEN: number | null; NUM_PREC: number | null; NUM_SCALE: number | null; IS_IDENTITY: number;
    }>(
      `SELECT col.name AS COLUMN_NAME, t.name AS DATA_TYPE, col.is_nullable AS IS_NULLABLE,
              dc.definition AS COLUMN_DEFAULT, col.column_id AS ORD,
              col.max_length AS CHAR_LEN, col.precision AS NUM_PREC, col.scale AS NUM_SCALE,
              col.is_identity AS IS_IDENTITY
         FROM sys.columns col
         JOIN sys.objects o ON o.object_id = col.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.types t ON t.user_type_id = col.user_type_id
         LEFT JOIN sys.default_constraints dc ON dc.object_id = col.default_object_id
        WHERE s.name = @p0 AND o.name = @p1
        ORDER BY col.column_id`,
      [schema, name],
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
      [schema, name],
    );
    const pkCols = new Set(idxRows.filter((r) => Number(r.IS_PRIMARY) === 1).map((r) => r.COLUMN_NAME));
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: c.COLUMN_NAME,
      dataType: formatMssqlType(c.DATA_TYPE, c.CHAR_LEN, c.NUM_PREC, c.NUM_SCALE),
      nullable: Number(c.IS_NULLABLE) === 1,
      isPrimaryKey: pkCols.has(c.COLUMN_NAME),
      isAutoIncrement: Number(c.IS_IDENTITY) === 1,
      defaultValue: c.COLUMN_DEFAULT,
      ordinal: c.ORD,
      charMaxLength: mssqlCharacterLength(c.DATA_TYPE, c.CHAR_LEN),
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
      [schema, name],
    );
    const foreignKeys = groupForeignKeys(fkRows);

    return { schema, name, kind: 'table', columns, indexes, foreignKeys };
  }

  async function listIncomingForeignKeys(schemaName: string, name: string): Promise<IncomingForeignKeyInfo[]> {
    const targetSchema = schemaName || 'dbo';
    const fkRows = await rows<{
      FK_NAME: string; SOURCE_SCHEMA: string; SOURCE_TABLE: string; COLUMN_NAME: string;
      REF_SCHEMA: string; REF_TABLE: string; REF_COLUMN: string; DELETE_RULE: string; UPDATE_RULE: string;
    }>(
      `SELECT fk.name AS FK_NAME, s.name AS SOURCE_SCHEMA, o.name AS SOURCE_TABLE, pc.name AS COLUMN_NAME,
              rs.name AS REF_SCHEMA, rt.name AS REF_TABLE, rc.name AS REF_COLUMN,
              fk.delete_referential_action_desc AS DELETE_RULE, fk.update_referential_action_desc AS UPDATE_RULE
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.objects o ON o.object_id = fk.parent_object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.columns pc ON pc.object_id = fk.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN sys.columns rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE rs.name = @p0 AND rt.name = @p1
        ORDER BY s.name, o.name, fk.name, fkc.constraint_column_id`,
      [targetSchema, name],
    );
    const grouped = new Map<string, IncomingForeignKeyInfo>();
    const normalizeAction = (value: string): string => value.replace(/_/g, ' ');
    for (const row of fkRows) {
      const key = `${row.SOURCE_SCHEMA}\0${row.SOURCE_TABLE}\0${row.FK_NAME}`;
      let relation = grouped.get(key);
      if (!relation) {
        relation = {
          schema: row.SOURCE_SCHEMA,
          table: row.SOURCE_TABLE,
          foreignKey: {
            name: row.FK_NAME, columns: [], refSchema: row.REF_SCHEMA, refTable: row.REF_TABLE, refColumns: [],
            onDelete: normalizeAction(row.DELETE_RULE), onUpdate: normalizeAction(row.UPDATE_RULE),
          },
        };
        grouped.set(key, relation);
      }
      relation.foreignKey.columns.push(row.COLUMN_NAME);
      relation.foreignKey.refColumns.push(row.REF_COLUMN);
    }
    return [...grouped.values()];
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
    listIncomingForeignKeys,
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
    runBatch,
    explain: explainQuery,
    query(sql, params) {
      return runQuery(sql, { params });
    },
    async close() {
      await pool.close();
    },
  };
  return driver;
}

/** Shape a node-mssql query output into a capped QueryResult. */
function shapeMssqlResult(result: MssqlQueryOutput, max: number): QueryResult {
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
