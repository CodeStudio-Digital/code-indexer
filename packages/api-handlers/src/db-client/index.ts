/**
 * Handlers for the `dbClient` namespace — the embedded database client.
 *
 * Runs in the Electron main process next to the SSH connection manager. The
 * connection pools live in the shared `@mcp/db-drivers` `DbConnectionManager`
 * (one pool registry per process, also used by the `db_*` agent tools).
 *
 * Secret handling: the renderer decrypts a saved secret and hands the plaintext
 * password inside the `DbConnectSpec` over the in-process IPC channel. We
 * consume it into the pool config and never persist or re-emit it; later ops
 * carry only a `connectionId`.
 */

import { ApiError, type DbClientApi, type DbConnectSpec, type DbTableInfo } from '@mcp/api-bus';
import {
  buildDdl,
  buildDml,
  createDriver,
  quoteIdent,
  quoteRelation,
  sharedDbConnectionManager,
  type ColumnSpec,
  type DbConnectConfig,
  type DbEngine,
  type RowChange,
} from '@mcp/db-drivers';
import type { HandlerDeps } from '../types.js';

/** Pool key for a UI connection — distinct keyspace from the agent pools. */
function keyFor(connectionId: string): string {
  return `conn:${connectionId}`;
}

/**
 * In-flight query cancellation, keyed by `${connectionId}:${queryId}`. MODULE
 * scope (not per-handler-instance) so a cancel that lands on a different handler
 * instance than the running query still finds the controller.
 */
const inflight = new Map<string, AbortController>();

function toConfig(spec: DbConnectSpec): DbConnectConfig {
  return {
    engine: spec.engine,
    host: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    database: spec.database,
    filePath: spec.filePath,
    connectionString: spec.connectionString,
    ssl: spec.ssl,
    options: spec.options,
  };
}

/** Strip comments + string/identifier literals so keyword/`;` checks aren't fooled. */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, '``');
}

/** True when the buffer contains more than one top-level statement. */
function hasMultipleStatements(sql: string): boolean {
  return stripSqlNoise(sql).replace(/;+\s*$/, '').includes(';');
}

const WRITE_KW = /\b(insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|attach|detach|vacuum|reindex|call)\b/i;

/**
 * Strict read-only classifier. A statement is read-safe only if it is a SINGLE
 * statement, leads with a read verb, is not `EXPLAIN ANALYZE` (which executes),
 * and contains NO write keyword anywhere (catches data-modifying CTEs like
 * `WITH x AS (DELETE …) …`). Conservative by design: a few benign statements
 * (writing-looking but harmless) may be rejected under read-only — that is the
 * safe failure direction for a security valve.
 */
function isReadStatement(sql: string): boolean {
  const s = stripSqlNoise(sql).trim();
  if (!s) return false;
  if (s.replace(/;+\s*$/, '').includes(';')) return false; // single statement only
  if (!/^(select|show|explain|describe|desc|with)\b/i.test(s)) return false;
  if (/^explain\b/i.test(s) && /\banalyze\b/i.test(s)) return false; // EXPLAIN ANALYZE runs it
  if (WRITE_KW.test(s)) return false; // writing CTE / any embedded write
  return true;
}

export function createDbClientHandlers(_deps: HandlerDeps): DbClientApi {
  const mgr = sharedDbConnectionManager();
  // Engine + read-only live on the SHARED manager (not this closure), so the
  // IPC handler instance, the Hono-fallback instance and the agent path all
  // resolve them from one place — otherwise editRow/ddl could hit an instance
  // whose maps are empty and (wrongly) report "not connected".

  function requireDriver(connectionId: string) {
    const driver = mgr.get(keyFor(connectionId));
    if (!driver) throw new ApiError('db_not_connected', 409, `Not connected: ${connectionId}`);
    return driver;
  }

  function requireEngine(connectionId: string): DbEngine {
    const engine = mgr.getMeta(keyFor(connectionId))?.engine;
    if (!engine) throw new ApiError('db_not_connected', 409, `Not connected: ${connectionId}`);
    return engine;
  }

  function assertWritable(connectionId: string): void {
    if (mgr.getMeta(keyFor(connectionId))?.readOnly) {
      throw new ApiError('db_read_only', 403, 'Connection is read-only — writes are blocked.');
    }
  }

  return {
    async testConnection({ spec }) {
      const driver = await createDriver(toConfig(spec));
      try {
        const { serverVersion } = await driver.testConnection();
        return { ok: true, serverVersion };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        await driver.close().catch(() => void 0);
      }
    },

    async connect({ spec }) {
      const key = keyFor(spec.connectionId);
      // A fresh Connect uses fresh credentials — drop any prior pool first.
      await mgr.closeKey(key);
      const driver = await mgr.acquire(key, toConfig(spec), { pinned: true });
      mgr.setMeta(key, { engine: spec.engine, readOnly: !!spec.readOnly });
      let serverVersion: string | undefined;
      try {
        serverVersion = (await driver.testConnection()).serverVersion;
      } catch (err) {
        // Connect failed at ping — tear the pool down so we don't leak it.
        await mgr.closeKey(key);
        throw new ApiError('db_connect_failed', 502, err instanceof Error ? err.message : String(err));
      }
      return { sessionToken: `dbsess:${spec.connectionId}`, serverVersion };
    },

    async disconnect({ connectionId }) {
      await mgr.closeKey(keyFor(connectionId));
    },

    async listDatabases({ connectionId }) {
      return requireDriver(connectionId).listDatabases();
    },

    async introspect({ connectionId, database, schema }) {
      const driver = requireDriver(connectionId);
      if (schema) {
        return { schemas: [], tables: await driver.listTables(schema) };
      }
      return { schemas: await driver.listSchemas(database), tables: [] };
    },

    async describeTable({ connectionId, schema, table }) {
      const info = await requireDriver(connectionId).describeTable(schema, table);
      return info as DbTableInfo;
    },

    async tableRows({ connectionId, schema, table, limit, offset }) {
      const started = Date.now();
      const res = await requireDriver(connectionId).tablePreview(schema, table, { limit, offset });
      return { ...res, durationMs: Date.now() - started };
    },

    async listObjects({ connectionId, kind, schema, table }) {
      return requireDriver(connectionId).listObjects(kind, schema, table);
    },

    async generateSql({ connectionId, schema, table, kind }) {
      const driver = requireDriver(connectionId);
      const engine = requireEngine(connectionId);
      const rel = quoteRelation(engine, schema, table);
      if (kind === 'select') return { sql: `SELECT * FROM ${rel} LIMIT 100;` };
      if (kind === 'truncate') {
        // SQLite has no TRUNCATE — DELETE FROM is the equivalent.
        return { sql: engine === 'sqlite' ? `DELETE FROM ${rel};` : `TRUNCATE TABLE ${rel};` };
      }
      // Default the schema for relational engines so describeTable doesn't match
      // zero rows (which would emit a column-less CREATE).
      const effSchema = schema ?? (engine === 'postgres' ? 'public' : undefined);
      const info = await driver.describeTable(effSchema ?? '', table);
      if (kind === 'insert') {
        const cols = info.columns.filter((c) => !c.isAutoIncrement);
        const colList = cols.map((c) => quoteIdent(engine, c.name)).join(', ');
        const values = cols.map(() => 'NULL').join(', ');
        return { sql: `INSERT INTO ${rel} (${colList})\nVALUES (${values});` };
      }
      // 'create' — reconstruct CREATE TABLE from the introspected columns.
      const columns: ColumnSpec[] = info.columns.map((c) => ({
        name: c.name,
        type: c.dataType,
        nullable: c.nullable,
        default: c.defaultValue ?? null,
        primaryKey: c.isPrimaryKey,
        autoIncrement: c.isAutoIncrement,
      }));
      return { sql: buildDdl(engine, 'create', { create: { schema: effSchema, table, columns } }).join(';\n') + ';' };
    },

    async query({ connectionId, sql, params, maxRows, queryId, schema }) {
      const driver = requireDriver(connectionId);
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && !isReadStatement(sql)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — only SELECT statements are allowed.');
      }
      const controller = new AbortController();
      const inflightKey = queryId ? `${connectionId}:${queryId}` : null;
      if (inflightKey) inflight.set(inflightKey, controller);
      const started = Date.now();
      try {
        const result = await driver.runQuery(sql, { params, maxRows, schema, signal: controller.signal });
        return { ...result, durationMs: Date.now() - started };
      } finally {
        if (inflightKey) inflight.delete(inflightKey);
      }
    },

    async cancel({ connectionId, queryId }) {
      inflight.get(`${connectionId}:${queryId}`)?.abort();
    },

    async explain({ connectionId, sql }) {
      const engine = requireEngine(connectionId);
      // A trailing statement would EXECUTE (EXPLAIN binds only the first); refuse it.
      if (hasMultipleStatements(sql)) throw new ApiError('db_explain_multi', 400, 'Explain expects a single statement.');
      // On a read-only connection, only read statements may be explained (blocks
      // EXPLAIN ANALYZE of a write, which would run it).
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && !isReadStatement(sql)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — only read statements can be explained.');
      }
      const prefix = engine === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
      const started = Date.now();
      const res = await requireDriver(connectionId).runQuery(prefix + sql, { maxRows: 2000 });
      return { ...res, durationMs: Date.now() - started };
    },

    async editRow({ connectionId, op, schema, table, pk, values, dryRun }) {
      assertWritable(connectionId);
      const engine = requireEngine(connectionId);
      const change: RowChange = { op, schema, table, pk, values };
      const built = buildDml(engine, change);
      if (dryRun) return { sql: built.display };
      const result = await requireDriver(connectionId).runQuery(built.sql, { params: built.params });
      return { sql: built.display, result };
    },

    async ddl({ connectionId, op, spec, dryRun }) {
      assertWritable(connectionId);
      const engine = requireEngine(connectionId);
      const statements = buildDdl(engine, op, spec);
      const sql = statements.join(';\n') + ';';
      if (dryRun) return { sql };
      // An all-comment set means the engine can't express the change (e.g. SQLite
      // modify-column / FK needs a table rebuild). Surface it instead of silently
      // reporting success after touching nothing.
      if (statements.every((s) => /^\s*--/.test(s))) {
        throw new ApiError('db_ddl_unsupported', 422, statements.join('\n').replace(/^\s*--\s?/gm, '') || 'Unsupported DDL.');
      }
      const driver = requireDriver(connectionId);
      let result;
      for (const stmt of statements) {
        if (/^\s*--/.test(stmt)) continue; // skip comment lines mixed into a larger set
        result = await driver.runQuery(stmt);
      }
      return { sql, result };
    },
  };
}
