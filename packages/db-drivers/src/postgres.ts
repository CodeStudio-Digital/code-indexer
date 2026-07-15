/**
 * PostgreSQL driver (node-postgres `pg`, pure JS — already a root dependency).
 *
 * Cancellation: each query runs on a dedicated pooled client whose backend PID
 * is captured up front; on `signal.abort` a side client issues
 * `pg_cancel_backend(pid)`. Rows are capped by `maxRows` (streaming is P4).
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
  RunBatchOptions,
  RunQueryOptions,
  TableInfo,
  TableRef,
} from './types.js';

// Minimal structural types so we don't hard-depend on `pg`'s types at build time.
interface PgClient {
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult | PgResult[]>;
  /** Passing an error evicts the client from the pool instead of recycling it. */
  release(err?: Error | boolean): void;
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
  // Never wait forever on a black-holed host (pg default is 0 = infinite).
  extra.connectionTimeoutMillis = typeof opts.connectTimeoutMs === 'number' ? opts.connectTimeoutMs : 10_000;
  if (typeof opts.applicationName === 'string' && opts.applicationName) extra.application_name = opts.applicationName;
  // Server-side default for every pooled session. The factory guard remains the
  // first boundary; this stops local table changes even if a read-shaped SQL
  // construct slips past classification.
  if (config.readOnly) extra.options = '-c default_transaction_read_only=on';
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
      return shapePgResult(raw, max);
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      // Reset the search_path so the pooled client is clean for the next borrower.
      // If RESET fails (e.g. an in-flight cancel landed on it), EVICT the client
      // (release with an error) so a dirty search_path can't leak to the next use.
      if (opts.schema) {
        try {
          await client.query({ text: 'RESET search_path' });
          client.release();
        } catch (e) {
          client.release(e instanceof Error ? e : new Error(String(e)));
        }
      } else {
        client.release();
      }
    }
  }

  async function runBatch(statements: string[], opts: RunBatchOptions = {}): Promise<QueryResult> {
    if (config.readOnly) throw new Error('Connection is read-only — batch execution is blocked.');
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    // ONE pinned client for the whole batch — a runQuery loop could hand each
    // statement a different pooled backend, so BEGIN/COMMIT wouldn't share one
    // transaction. Here BEGIN…COMMIT and every statement land on this client.
    const client = await pool.connect();
    let onAbort: (() => void) | null = null;
    let inTxn = false;
    let dirty = false;
    try {
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        const pidRes = (await client.query({ text: 'SELECT pg_backend_pid() AS pid' })) as PgResult;
        const pid = Number((pidRes.rows[0] as { pid: number }).pid);
        onAbort = (): void => {
          // Side connection so the cancel isn't blocked behind the running batch.
          pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => void 0);
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      await client.query({ text: 'BEGIN' });
      inTxn = true;
      let last: QueryResult = { rows: [], rowCount: 0, fields: [] };
      for (const stmt of statements) {
        last = shapePgResult(await client.query({ text: stmt }), max);
      }
      await client.query({ text: 'COMMIT' });
      inTxn = false;
      return last;
    } catch (err) {
      // A failed statement leaves the txn in the aborted state — ROLLBACK clears
      // it so the connection recycles clean. If even ROLLBACK fails, evict it.
      if (inTxn) {
        try {
          await client.query({ text: 'ROLLBACK' });
        } catch {
          dirty = true;
        }
      }
      throw err;
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      client.release(dirty ? new Error('db-batch: rollback failed') : undefined);
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
      `SELECT c.column_name, c.data_type, c.udt_name, c.udt_schema, c.is_nullable, c.column_default,
              c.ordinal_position, c.character_maximum_length, c.numeric_precision,
              pgd.description AS comment,
              ARRAY(
                SELECT e.enumlabel
                  FROM pg_catalog.pg_type enum_type
                  JOIN pg_catalog.pg_namespace enum_ns ON enum_ns.oid = enum_type.typnamespace
                  JOIN pg_catalog.pg_enum e ON e.enumtypid = enum_type.oid
                 WHERE enum_type.typname = c.udt_name AND enum_ns.nspname = c.udt_schema
                 ORDER BY e.enumsortorder
              ) AS enum_values
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
        udt_schema: string;
        is_nullable: string;
        column_default: string | null;
        ordinal_position: number;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        comment: string | null;
        enum_values: string[];
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
      enumValues: c.enum_values.length > 0 ? c.enum_values : undefined,
    }));

    const idxRes = await pool.query(
      // indkey is an int2vector; cast to int2[] so array_position resolves.
      `SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              a.attname AS column_name, array_position(ix.indkey::int2[], a.attnum) AS ord
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey::int2[])
        WHERE n.nspname = $1 AND t.relname = $2
        ORDER BY index_name, ord`,
      [schemaName, name],
    );
    const indexes = groupIndexes(
      idxRes.rows as Array<{ index_name: string; is_unique: boolean; is_primary: boolean; column_name: string }>,
    );

    // pg_constraint + WITH ORDINALITY pairs local↔referenced columns positionally
    // (information_schema's kcu×ccu join cross-products composite FKs).
    const fkRes = await pool.query(
      `SELECT con.conname AS constraint_name,
              att.attname AS column_name,
              fns.nspname AS ref_schema, fcl.relname AS ref_table, fatt.attname AS ref_column,
              con.confdeltype AS delete_rule, con.confupdtype AS update_rule
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_class fcl ON fcl.oid = con.confrelid
         JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
         JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att_local, att_ref, ord) ON true
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.att_local
         JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = k.att_ref
        WHERE con.contype = 'f' AND ns.nspname = $1 AND cl.relname = $2
        ORDER BY con.conname, k.ord`,
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
    kind: 'relational',
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
    async listObjects(kind, schemaName = 'public', table) {
      if (kind === 'triggers') {
        const res = await pool.query(
          `SELECT DISTINCT trigger_name FROM information_schema.triggers
            WHERE event_object_schema = $1 AND event_object_table = $2 ORDER BY trigger_name`,
          [schemaName, table ?? ''],
        );
        return (res.rows as Array<{ trigger_name: string }>).map((r) => r.trigger_name);
      }
      if (kind === 'functions') {
        const res = await pool.query(
          `SELECT routine_name FROM information_schema.routines
            WHERE routine_schema = $1 ORDER BY routine_name`,
          [schemaName],
        );
        return (res.rows as Array<{ routine_name: string }>).map((r) => r.routine_name);
      }
      const res = await pool.query(
        `SELECT sequence_name FROM information_schema.sequences
          WHERE sequence_schema = $1 ORDER BY sequence_name`,
        [schemaName],
      );
      return (res.rows as Array<{ sequence_name: string }>).map((r) => r.sequence_name);
    },
    tablePreview(schemaName, name, opts) {
      const rel = `${qIdent(schemaName)}.${qIdent(name)}`;
      const { sql, params } = buildTablePreview('postgres', rel, opts);
      return runQuery(sql, { params, maxRows: opts.limit });
    },
    async schema(schemaName = 'public') {
      const tables = await driver.listTables(schemaName);
      const out: TableInfo[] = [];
      for (const t of tables) out.push(await describeTable(t.schema, t.name));
      return out;
    },
    runQuery,
    runBatch,
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

/** Shape a raw pg result (or multi-statement array) into a capped QueryResult. */
function shapePgResult(raw: PgResult | PgResult[], max: number): QueryResult {
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

/** pg_constraint conf{del,upd}type single-char codes → SQL referential action. */
function pgFkAction(code: string): string | undefined {
  switch (code) {
    case 'c':
      return 'CASCADE';
    case 'r':
      return 'RESTRICT';
    case 'n':
      return 'SET NULL';
    case 'd':
      return 'SET DEFAULT';
    case 'a':
      return 'NO ACTION';
    default:
      return undefined;
  }
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
        onDelete: pgFkAction(r.delete_rule),
        onUpdate: pgFkAction(r.update_rule),
      };
      map.set(r.constraint_name, fk);
    }
    fk.columns.push(r.column_name);
    fk.refColumns.push(r.ref_column);
  }
  return [...map.values()];
}
