/**
 * PostgreSQL driver (node-postgres `pg`, pure JS — already a root dependency).
 *
 * Cancellation: each query runs on a dedicated pooled client whose backend PID
 * is captured up front; on `signal.abort` a side client issues
 * `pg_cancel_backend(pid)`. Rows are capped by `maxRows` (streaming is P4).
 */
import { DEFAULT_MAX_ROWS } from './types.js';
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

// Minimal structural types so we don't hard-depend on `pg`'s types at build time.
interface PgClient {
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult | PgResult[]>;
  release(): void;
}
interface PgResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
  command?: string;
  fields?: Array<{ name: string; dataTypeID?: number }>;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, values?: unknown[]): Promise<PgResult>;
  end(): Promise<void>;
}

function buildPoolConfig(config: DbConnectConfig): Record<string, unknown> {
  const opts = config.options ?? {};
  const extra: Record<string, unknown> = { max: 3 };
  if (typeof opts.connectTimeoutMs === 'number') extra.connectionTimeoutMillis = opts.connectTimeoutMs;
  if (typeof opts.applicationName === 'string' && opts.applicationName) extra.application_name = opts.applicationName;
  if (config.connectionString) return { connectionString: config.connectionString, ...extra };
  const ssl = sslConfig(config);
  return {
    host: config.host,
    port: config.port ?? 5432,
    user: config.user,
    password: config.password,
    database: config.database,
    ...(ssl ? { ssl } : {}),
    ...extra,
  };
}

function sslConfig(config: DbConnectConfig): Record<string, unknown> | undefined {
  const mode = config.ssl?.mode;
  if (!mode || mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ca: config.ssl?.ca,
    cert: config.ssl?.cert,
    key: config.ssl?.key,
  };
}

export async function createPostgresDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  const { default: pg } = (await import('pg')) as unknown as { default: { Pool: new (c: unknown) => PgPool } };
  const pool = new pg.Pool(buildPoolConfig(config));

  async function runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const client = await pool.connect();
    let pid: number | null = null;
    let onAbort: (() => void) | null = null;
    try {
      const pidRes = (await client.query({ text: 'SELECT pg_backend_pid() AS pid' })) as PgResult;
      pid = Number((pidRes.rows[0] as { pid: number }).pid);
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        onAbort = (): void => {
          // Side connection so the cancel isn't blocked behind the running query.
          pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => void 0);
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      // Schema-scoped console: set the search_path on THIS dedicated client only.
      if (opts.schema) {
        await client.query({ text: `SET search_path TO ${qIdent(opts.schema)}, public` });
      }
      const raw = await client.query({ text: sql, values: opts.params });
      const result = Array.isArray(raw) ? lastWithRows(raw) : raw;
      const rows = result.rows ?? [];
      const truncated = rows.length > max;
      return {
        rows: truncated ? rows.slice(0, max) : rows,
        rowCount: result.rowCount ?? rows.length,
        fields: (result.fields ?? []).map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
        command: result.command,
        truncated,
      };
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      // Reset the search_path so the pooled client is clean for the next borrower.
      if (opts.schema) await client.query({ text: 'RESET search_path' }).catch(() => void 0);
      client.release();
    }
  }

  async function describeTable(schemaName: string, name: string): Promise<TableInfo> {
    const pkRes = await pool.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schemaName, name],
    );
    const pkCols = new Set((pkRes.rows as Array<{ column_name: string }>).map((r) => r.column_name));

    const colsRes = await pool.query(
      `SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
              c.ordinal_position, c.character_maximum_length, c.numeric_precision,
              pgd.description AS comment
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON st.schemaname = c.table_schema AND st.relname = c.table_name
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`,
      [schemaName, name],
    );
    const columns: ColumnInfo[] = (
      colsRes.rows as Array<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        ordinal_position: number;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        comment: string | null;
      }>
    ).map((c) => ({
      name: c.column_name,
      dataType: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
      nullable: c.is_nullable === 'YES',
      isPrimaryKey: pkCols.has(c.column_name),
      isAutoIncrement: !!c.column_default && /nextval\(/i.test(c.column_default),
      defaultValue: c.column_default,
      ordinal: c.ordinal_position,
      charMaxLength: c.character_maximum_length,
      numericPrecision: c.numeric_precision,
      comment: c.comment,
    }));

    const idxRes = await pool.query(
      `SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              a.attname AS column_name, array_position(ix.indkey, a.attnum) AS ord
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname = $1 AND t.relname = $2
        ORDER BY index_name, ord`,
      [schemaName, name],
    );
    const indexes = groupIndexes(
      idxRes.rows as Array<{ index_name: string; is_unique: boolean; is_primary: boolean; column_name: string }>,
    );

    const fkRes = await pool.query(
      `SELECT tc.constraint_name, kcu.column_name,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column,
              rc.delete_rule, rc.update_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schemaName, name],
    );
    const foreignKeys = groupForeignKeys(
      fkRes.rows as Array<{
        constraint_name: string;
        column_name: string;
        ref_schema: string;
        ref_table: string;
        ref_column: string;
        delete_rule: string;
        update_rule: string;
      }>,
    );

    return { schema: schemaName, name, kind: 'table', columns, indexes, foreignKeys };
  }

  const driver: DatabaseDriver = {
    async testConnection() {
      const res = await pool.query('SELECT version() AS v');
      return { serverVersion: (res.rows[0] as { v: string } | undefined)?.v };
    },
    async listDatabases() {
      const res = await pool.query(
        'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
      );
      return (res.rows as Array<{ datname: string }>).map((r) => r.datname);
    },
    async listSchemas() {
      const res = await pool.query(
        `SELECT schema_name FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
            AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%'
          ORDER BY schema_name`,
      );
      return (res.rows as Array<{ schema_name: string }>).map((r) => r.schema_name);
    },
    async listTables(schemaName = 'public') {
      const res = await pool.query(
        `SELECT table_name, table_type FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name`,
        [schemaName],
      );
      return (res.rows as Array<{ table_name: string; table_type: string }>).map((r) => ({
        schema: schemaName,
        name: r.table_name,
        kind: r.table_type === 'VIEW' ? ('view' as const) : ('table' as const),
      })) satisfies TableRef[];
    },
    describeTable,
    tablePreview(schemaName, name, { limit, offset }) {
      const rel = `${qIdent(schemaName)}.${qIdent(name)}`;
      return runQuery(`SELECT * FROM ${rel} LIMIT $1 OFFSET $2`, { params: [limit, offset], maxRows: limit });
    },
    async schema(schemaName = 'public') {
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

/** Postgres identifier quoting: wrap in double-quotes, escaping embedded quotes. */
function qIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function lastWithRows(results: PgResult[]): PgResult {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].rows && results[i].rows.length > 0) return results[i];
  }
  return results[results.length - 1] ?? { rows: [], rowCount: 0 };
}

function groupIndexes(
  rows: Array<{ index_name: string; is_unique: boolean; is_primary: boolean; column_name: string }>,
): IndexInfo[] {
  const map = new Map<string, IndexInfo>();
  for (const r of rows) {
    let idx = map.get(r.index_name);
    if (!idx) {
      idx = { name: r.index_name, columns: [], unique: r.is_unique, primary: r.is_primary };
      map.set(r.index_name, idx);
    }
    idx.columns.push(r.column_name);
  }
  return [...map.values()];
}

function groupForeignKeys(
  rows: Array<{
    constraint_name: string;
    column_name: string;
    ref_schema: string;
    ref_table: string;
    ref_column: string;
    delete_rule: string;
    update_rule: string;
  }>,
): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    let fk = map.get(r.constraint_name);
    if (!fk) {
      fk = {
        name: r.constraint_name,
        columns: [],
        refSchema: r.ref_schema,
        refTable: r.ref_table,
        refColumns: [],
        onDelete: r.delete_rule,
        onUpdate: r.update_rule,
      };
      map.set(r.constraint_name, fk);
    }
    fk.columns.push(r.column_name);
    fk.refColumns.push(r.ref_column);
  }
  return [...map.values()];
}
