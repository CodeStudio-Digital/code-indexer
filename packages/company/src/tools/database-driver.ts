/**
 * Driver abstraction for the `db_*` agent tools.
 *
 * Isolates SQL-dialect-specific behavior (Postgres vs MySQL) behind a
 * single interface. Adding a new wire protocol in the future = new
 * implementation + one case in `createDriver`; tools stay untouched.
 *
 * Module caches pools keyed by database id so repeated `db_query`
 * calls from the same agent reuse connections. Idle drivers are
 * closed by a periodic sweeper (TTL 5 minutes).
 */

import type { DatabaseWireProtocol } from '@mcp/company/database-types.js';

export interface QueryField {
  name: string;
  dataTypeId?: number;
}

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  fields: QueryField[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

export interface DatabaseDriver {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  schema(schemaName?: string): Promise<TableInfo[]>;
  close(): Promise<void>;
}

// ─── Pool cache ──────────────────────────────────────────────────

interface PoolEntry {
  driver: DatabaseDriver;
  lastUsed: number;
}

const IDLE_TTL_MS = 5 * 60 * 1000;
const pools = new Map<string, PoolEntry>();
let sweeperTimer: NodeJS.Timeout | null = null;

function ensureSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [key, entry] of pools.entries()) {
      if (entry.lastUsed < cutoff) {
        entry.driver.close().catch(() => void 0);
        pools.delete(key);
      }
    }
    if (pools.size === 0 && sweeperTimer) {
      clearInterval(sweeperTimer);
      sweeperTimer = null;
    }
  }, 60 * 1000);
  // Don't keep the process alive for a cache sweeper.
  if (typeof sweeperTimer.unref === 'function') sweeperTimer.unref();
}

/**
 * Look up (or create) a driver for the given session+db. Entries are
 * tagged by (sessionId, dbId, url) — URL changes invalidate the cached
 * pool so env rotations take effect on next query.
 */
export async function getDriver(
  sessionId: number,
  dbId: number,
  wireProtocol: DatabaseWireProtocol,
  connectionUrl: string,
): Promise<DatabaseDriver> {
  ensureSweeper();
  const key = `${sessionId}:${dbId}:${connectionUrl}`;
  const existing = pools.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.driver;
  }
  // Stale entries for the same (sessionId, dbId) with a different URL
  // (e.g. user rotated the env) should be closed eagerly.
  for (const [k, v] of pools.entries()) {
    if (k.startsWith(`${sessionId}:${dbId}:`)) {
      v.driver.close().catch(() => void 0);
      pools.delete(k);
    }
  }
  const driver = await createDriver(wireProtocol, connectionUrl);
  pools.set(key, { driver, lastUsed: Date.now() });
  return driver;
}

/** Close all pooled drivers. For tests and graceful shutdown. */
export async function closeAllDrivers(): Promise<void> {
  const drivers = [...pools.values()].map((e) => e.driver);
  pools.clear();
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
  await Promise.allSettled(drivers.map((d) => d.close()));
}

// ─── Factory ─────────────────────────────────────────────────────

export async function createDriver(
  wireProtocol: DatabaseWireProtocol,
  connectionUrl: string,
): Promise<DatabaseDriver> {
  if (wireProtocol === 'postgres') {
    return createPostgresDriver(connectionUrl);
  }
  if (wireProtocol === 'mysql') {
    return createMysqlDriver(connectionUrl);
  }
  throw new Error(`Unsupported wire protocol: ${String(wireProtocol)}`);
}

// ─── Postgres impl ───────────────────────────────────────────────

async function createPostgresDriver(url: string): Promise<DatabaseDriver> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 3 });

  return {
    async query(sql, params) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return {
        rows: result.rows as Array<Record<string, unknown>>,
        rowCount: result.rowCount ?? result.rows.length,
        fields: (result.fields ?? []).map((f) => ({
          name: f.name,
          dataTypeId: f.dataTypeID,
        })),
      };
    },
    async schema(schemaName) {
      const target = schemaName ?? 'public';
      const tablesRes = await pool.query(
        `SELECT table_schema, table_name
           FROM information_schema.tables
          WHERE table_schema = $1
            AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
        [target],
      );
      const tables: TableInfo[] = [];
      for (const row of tablesRes.rows as Array<{
        table_schema: string;
        table_name: string;
      }>) {
        const colsRes = await pool.query(
          `SELECT c.column_name, c.data_type, c.is_nullable,
                  (SELECT COUNT(*) FROM information_schema.table_constraints tc
                     JOIN information_schema.key_column_usage kcu
                       ON tc.constraint_name = kcu.constraint_name
                      AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND kcu.table_schema = c.table_schema
                      AND kcu.table_name = c.table_name
                      AND kcu.column_name = c.column_name) AS pk_count
             FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position`,
          [row.table_schema, row.table_name],
        );
        tables.push({
          schema: row.table_schema,
          name: row.table_name,
          columns: (
            colsRes.rows as Array<{
              column_name: string;
              data_type: string;
              is_nullable: string;
              pk_count: number | string;
            }>
          ).map((c) => ({
            name: c.column_name,
            dataType: c.data_type,
            nullable: c.is_nullable === 'YES',
            isPrimaryKey: Number(c.pk_count) > 0,
          })),
        });
      }
      return tables;
    },
    async close() {
      await pool.end();
    },
  };
}

// ─── MySQL impl ──────────────────────────────────────────────────

async function createMysqlDriver(url: string): Promise<DatabaseDriver> {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({ uri: url, connectionLimit: 3 });

  return {
    async query(sql, params) {
      const [rows, fields] = await pool.query(sql, params as unknown[] | undefined);
      if (Array.isArray(rows)) {
        return {
          rows: rows as Array<Record<string, unknown>>,
          rowCount: rows.length,
          fields: Array.isArray(fields)
            ? fields.map((f) => ({ name: (f as { name: string }).name }))
            : [],
        };
      }
      // DDL / DML without SELECT — rows is an OkPacket.
      const ok = rows as { affectedRows?: number };
      return {
        rows: [],
        rowCount: ok.affectedRows ?? 0,
        fields: [],
      };
    },
    async schema(schemaName) {
      // For MySQL "schema" == "database"; default to the one in the URL.
      const [tablesRaw] = await pool.query(
        schemaName
          ? `SELECT TABLE_SCHEMA, TABLE_NAME
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ?
                AND TABLE_TYPE = 'BASE TABLE'
              ORDER BY TABLE_NAME`
          : `SELECT TABLE_SCHEMA, TABLE_NAME
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_TYPE = 'BASE TABLE'
              ORDER BY TABLE_NAME`,
        schemaName ? [schemaName] : [],
      );
      const tableRows = Array.isArray(tablesRaw)
        ? (tablesRaw as Array<{ TABLE_SCHEMA: string; TABLE_NAME: string }>)
        : [];
      const tables: TableInfo[] = [];
      for (const row of tableRows) {
        const [colsRaw] = await pool.query(
          `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION`,
          [row.TABLE_SCHEMA, row.TABLE_NAME],
        );
        const colRows = Array.isArray(colsRaw)
          ? (colsRaw as Array<{
              COLUMN_NAME: string;
              DATA_TYPE: string;
              IS_NULLABLE: string;
              COLUMN_KEY: string;
            }>)
          : [];
        tables.push({
          schema: row.TABLE_SCHEMA,
          name: row.TABLE_NAME,
          columns: colRows.map((c) => ({
            name: c.COLUMN_NAME,
            dataType: c.DATA_TYPE,
            nullable: c.IS_NULLABLE === 'YES',
            isPrimaryKey: c.COLUMN_KEY === 'PRI',
          })),
        });
      }
      return tables;
    },
    async close() {
      await pool.end();
    },
  };
}
