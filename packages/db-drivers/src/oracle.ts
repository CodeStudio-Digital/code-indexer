/**
 * Oracle driver (`oracledb`, THIN mode — no Instant Client needed). The package
 * is fetched on demand (resolveDriverEntry → the per-engine install dir) so it
 * never bloats the build. Relational, so it reuses the entire SQL pipeline.
 *
 * Identifiers are double-quoted (Oracle folds unquoted names to UPPERCASE, and
 * the data dictionary stores them uppercase). Binds are positional `:1,:2`.
 * Pagination uses `OFFSET … ROWS FETCH NEXT … ROWS ONLY` (12c+). Cancellation
 * via `connection.break()`.
 *
 * NOTE: written against the Oracle data dictionary but NOT verified against a
 * live server — exercise with a real instance before trusting writes.
 */
import { DEFAULT_MAX_ROWS } from './types.js';
import { resolveDriverEntry } from './driver-registry.js';
import { quoteRelation } from './sql/identifiers.js';
import { buildTablePreview } from './sql/preview.js';
import type {
  ColumnInfo, DatabaseDriver, DbConnectConfig, ForeignKeyInfo, IndexInfo, QueryResult, RunBatchOptions, RunQueryOptions, TableInfo, TableRef,
} from './types.js';

interface OraResult {
  rows?: Array<Record<string, unknown>>;
  metaData?: Array<{ name: string }>;
  rowsAffected?: number;
}
interface OraConn {
  execute(sql: string, binds?: unknown[], opts?: Record<string, unknown>): Promise<OraResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  break(): Promise<void>;
  close(): Promise<void>;
}
interface OraPool {
  getConnection(): Promise<OraConn>;
  close(drainSeconds?: number): Promise<void>;
}
interface OraModule {
  createPool(c: unknown): Promise<OraPool>;
  OUT_FORMAT_OBJECT: number;
}

// Oracle-maintained schemas the tree shouldn't surface as user data.
const SYSTEM_SCHEMAS = "'SYS','SYSTEM','OUTLN','XDB','CTXSYS','MDSYS','ORDSYS','ORDDATA','DBSNMP','APPQOSSYS','WMSYS','GSMADMIN_INTERNAL','AUDSYS','DVSYS','LBACSYS','OJVMSYS','OLAPSYS','SI_INFORMTN_SCHEMA','DIP','ORACLE_OCM','REMOTE_SCHEDULER_AGENT'";

function connectString(config: DbConnectConfig): string {
  if (config.connectionString) return config.connectionString;
  const host = config.host ?? 'localhost';
  const port = config.port ?? 1521;
  return `${host}:${port}/${config.database ?? 'XEPDB1'}`;
}

export async function createOracleDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  let mod: { default?: OraModule } & OraModule;
  try {
    mod = (await import(resolveDriverEntry('oracle'))) as typeof mod;
  } catch {
    throw new Error('oracle driver not installed — download it from the connection dialog');
  }
  const oracledb: OraModule = mod.default ?? mod;
  const pool = await oracledb.createPool({
    user: config.user,
    password: config.password,
    connectString: connectString(config),
    poolMin: 0,
    poolMax: 3,
    poolTimeout: 60,
  });

  async function runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const conn = await pool.getConnection();
    let onAbort: (() => void) | null = null;
    try {
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        onAbort = (): void => void conn.break().catch(() => undefined);
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      const res = await conn.execute(sql, opts.params ?? [], {
        maxRows: max + 1,
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
      });
      return shapeOracleResult(res, max);
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      await conn.close().catch(() => undefined);
    }
  }

  async function runBatch(statements: string[], opts: RunBatchOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    // ONE pooled connection with autoCommit OFF for the whole batch, so the list
    // shares a session (a runQuery loop opens a fresh autoCommit connection per
    // statement). CAVEAT: Oracle implicitly COMMITs on DDL, so the rollback covers
    // DML only — a DDL already applied mid-batch can't be undone.
    const conn = await pool.getConnection();
    let onAbort: (() => void) | null = null;
    let committed = false;
    try {
      if (opts.signal) {
        if (opts.signal.aborted) throw new Error('query cancelled');
        onAbort = (): void => void conn.break().catch(() => undefined);
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      let last: QueryResult = { rows: [], rowCount: 0, fields: [] };
      for (const stmt of statements) {
        const res = await conn.execute(stmt, [], {
          maxRows: max + 1,
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          autoCommit: false,
        });
        last = shapeOracleResult(res, max);
      }
      await conn.commit();
      committed = true;
      return last;
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      if (!committed) await conn.rollback().catch(() => undefined);
      await conn.close().catch(() => undefined);
    }
  }

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await runQuery(sql, { params, maxRows: 100_000 })).rows as T[];
  }

  async function describeTable(schemaName: string, name: string): Promise<TableInfo> {
    const cols = await rows<{
      COLUMN_NAME: string; DATA_TYPE: string; DATA_LENGTH: number | null; DATA_PRECISION: number | null;
      NULLABLE: string; DATA_DEFAULT: string | null; COLUMN_ID: number; IS_IDENTITY: string;
    }>(
      `SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.nullable,
              c.data_default, c.column_id,
              NVL((SELECT 'Y' FROM all_tab_identity_cols i
                    WHERE i.owner = c.owner AND i.table_name = c.table_name AND i.column_name = c.column_name
                    AND ROWNUM = 1), 'N') AS is_identity
         FROM all_tab_columns c
        WHERE c.owner = :1 AND c.table_name = :2
        ORDER BY c.column_id`,
      [schemaName, name],
    );
    const pkRows = await rows<{ COLUMN_NAME: string }>(
      `SELECT cc.column_name
         FROM all_constraints c
         JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
        WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'P'`,
      [schemaName, name],
    );
    const pkCols = new Set(pkRows.map((r) => r.COLUMN_NAME));
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: c.COLUMN_NAME,
      dataType: oracleType(c),
      nullable: c.NULLABLE === 'Y',
      isPrimaryKey: pkCols.has(c.COLUMN_NAME),
      isAutoIncrement: c.IS_IDENTITY === 'Y',
      defaultValue: c.DATA_DEFAULT == null ? null : String(c.DATA_DEFAULT).trim(),
      ordinal: c.COLUMN_ID,
      charMaxLength: c.DATA_LENGTH,
      numericPrecision: c.DATA_PRECISION,
    }));

    const idxRows = await rows<{ INDEX_NAME: string; UNIQUENESS: string; COLUMN_NAME: string }>(
      `SELECT i.index_name, i.uniqueness, ic.column_name
         FROM all_indexes i
         JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
        WHERE i.table_owner = :1 AND i.table_name = :2
        ORDER BY i.index_name, ic.column_position`,
      [schemaName, name],
    );
    const indexes = groupIndexes(idxRows, pkCols);

    const fkRows = await rows<{ CONSTRAINT_NAME: string; COLUMN_NAME: string; REF_TABLE: string; REF_COLUMN: string; DELETE_RULE: string }>(
      `SELECT c.constraint_name, cc.column_name, rc.table_name AS ref_table, rcc.column_name AS ref_column, c.delete_rule
         FROM all_constraints c
         JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
         JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
         JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
        WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'R'
        ORDER BY c.constraint_name, cc.position`,
      [schemaName, name],
    );
    const foreignKeys = groupForeignKeys(fkRows);

    return { schema: schemaName, name, kind: 'table', columns, indexes, foreignKeys };
  }

  const driver: DatabaseDriver = {
    kind: 'relational',
    async testConnection() {
      const r = await rows<{ V: string }>(`SELECT version AS v FROM product_component_version WHERE ROWNUM = 1`).catch(
        () => rows<{ V: string }>(`SELECT '1' AS v FROM dual`),
      );
      return { serverVersion: r[0]?.V };
    },
    async listDatabases() {
      return [config.database ?? 'oracle'];
    },
    async listSchemas() {
      const r = await rows<{ USERNAME: string }>(
        `SELECT DISTINCT owner AS username FROM all_tables WHERE owner NOT IN (${SYSTEM_SCHEMAS}) ORDER BY owner`,
      );
      return r.map((x) => x.USERNAME);
    },
    async listTables(schemaName) {
      const r = await rows<{ NAME: string; KIND: string }>(
        `SELECT table_name AS name, 'table' AS kind FROM all_tables WHERE owner = :1
          UNION ALL
         SELECT view_name AS name, 'view' AS kind FROM all_views WHERE owner = :2
         ORDER BY 1`,
        // oracledb binds an ARRAY by position — one value per placeholder occurrence.
        [schemaName ?? '', schemaName ?? ''],
      );
      return r.map((x) => ({ schema: schemaName ?? '', name: x.NAME, kind: x.KIND === 'view' ? ('view' as const) : ('table' as const) })) satisfies TableRef[];
    },
    describeTable,
    async listObjects(kind, schemaName, table) {
      const owner = schemaName ?? '';
      if (kind === 'sequences') {
        const r = await rows<{ NAME: string }>(`SELECT sequence_name AS name FROM all_sequences WHERE sequence_owner = :1 ORDER BY 1`, [owner]);
        return r.map((x) => x.NAME);
      }
      if (kind === 'triggers') {
        const r = await rows<{ NAME: string }>(
          `SELECT trigger_name AS name FROM all_triggers WHERE table_owner = :1 AND table_name = :2 ORDER BY 1`,
          [owner, table ?? ''],
        );
        return r.map((x) => x.NAME);
      }
      const r = await rows<{ NAME: string }>(
        `SELECT object_name AS name FROM all_objects WHERE owner = :1 AND object_type IN ('FUNCTION','PROCEDURE') ORDER BY 1`,
        [owner],
      );
      return r.map((x) => x.NAME);
    },
    tablePreview(schemaName, name, opts) {
      const rel = quoteRelation('oracle', schemaName, name);
      const { sql, params } = buildTablePreview('oracle', rel, opts);
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
    query(sql, params) {
      return runQuery(sql, { params });
    },
    async close() {
      await pool.close(0).catch(() => undefined);
    },
  };
  return driver;
}

/** Shape an oracledb execute result into a capped QueryResult. */
function shapeOracleResult(res: OraResult, max: number): QueryResult {
  const rows = res.rows ?? [];
  if (rows.length > 0 || (res.metaData?.length ?? 0) > 0) {
    const truncated = rows.length > max;
    return {
      rows: truncated ? rows.slice(0, max) : rows,
      rowCount: rows.length,
      fields: (res.metaData ?? []).map((m) => ({ name: m.name })),
      truncated,
    };
  }
  return { rows: [], rowCount: res.rowsAffected ?? 0, fields: [], command: 'OK' };
}

/** Render an Oracle type with its length/precision for display. */
function oracleType(c: { DATA_TYPE: string; DATA_LENGTH: number | null; DATA_PRECISION: number | null }): string {
  const t = c.DATA_TYPE;
  if ((t === 'NUMBER') && c.DATA_PRECISION) return `NUMBER(${c.DATA_PRECISION})`;
  if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|RAW)$/.test(t) && c.DATA_LENGTH) return `${t}(${c.DATA_LENGTH})`;
  return t;
}

function groupIndexes(rows: Array<{ INDEX_NAME: string; UNIQUENESS: string; COLUMN_NAME: string }>, pkCols: Set<string>): IndexInfo[] {
  const map = new Map<string, IndexInfo>();
  for (const r of rows) {
    let idx = map.get(r.INDEX_NAME);
    if (!idx) {
      idx = { name: r.INDEX_NAME, columns: [], unique: r.UNIQUENESS === 'UNIQUE', primary: false };
      map.set(r.INDEX_NAME, idx);
    }
    idx.columns.push(r.COLUMN_NAME);
  }
  // Mark the index backing the PK (all its columns are PK columns).
  for (const idx of map.values()) idx.primary = idx.columns.length > 0 && idx.columns.every((c) => pkCols.has(c));
  return [...map.values()];
}

function groupForeignKeys(rows: Array<{ CONSTRAINT_NAME: string; COLUMN_NAME: string; REF_TABLE: string; REF_COLUMN: string; DELETE_RULE: string }>): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    let fk = map.get(r.CONSTRAINT_NAME);
    if (!fk) {
      fk = { name: r.CONSTRAINT_NAME, columns: [], refTable: r.REF_TABLE, refColumns: [], onDelete: r.DELETE_RULE };
      map.set(r.CONSTRAINT_NAME, fk);
    }
    fk.columns.push(r.COLUMN_NAME);
    fk.refColumns.push(r.REF_COLUMN);
  }
  return [...map.values()];
}
