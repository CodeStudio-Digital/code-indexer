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

import { ApiError, type DbCatalogSnapshot, type DbClientApi, type DbConnectSpec, type DbDdlOp, type DbDdlSpec, type DbEngineKind, type DbQueryResult, type DbTableInfo } from '@mcp/api-bus';
import {
  buildDdl,
  buildDml,
  buildExplainStatement,
  buildSelectTemplate,
  buildSqliteRebuild,
  sqliteAlterNeedsRebuild,
  createDriver,
  defaultSchemaFor,
  hasMultipleStatements,
  insertLiteral,
  isReadStatement,
  isWriteCommand,
  quoteIdent,
  quoteRelation,
  sharedDbConnectionManager,
  type ColumnSpec,
  type DbConnectConfig,
  type DbEngine,
  type DatabaseDriver,
  type RowChange,
} from '@mcp/db-drivers';
import { installDbDriver, listDbDriverStatus } from '@mcp/services/db/driver-installer.js';
import type { HandlerDeps } from '../types.js';
import { sharedTunnelManager } from '../ssh/index.js';

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
const catalogCache = new Map<string, DbCatalogSnapshot>();
const dbTunnelByConnection = new Map<string, string>();
const CATALOG_TTL_MS = 5 * 60_000;

/** Keep an interactive query bounded while still allowing reports to finish. */
export const MIN_QUERY_TIMEOUT_MS = 1_000;
export const MAX_QUERY_TIMEOUT_MS = 60 * 60_000;

/** Validate an untrusted per-query deadline before handing it to a driver. */
export function parseQueryTimeoutMs(timeoutMs: unknown): number | undefined {
  if (timeoutMs == null) return undefined;
  if (
    typeof timeoutMs !== 'number'
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_QUERY_TIMEOUT_MS
    || timeoutMs > MAX_QUERY_TIMEOUT_MS
  ) {
    throw new ApiError(
      'db_invalid_query_timeout',
      400,
      `Query timeout must be an integer between ${MIN_QUERY_TIMEOUT_MS}ms and ${MAX_QUERY_TIMEOUT_MS}ms.`,
    );
  }
  return timeoutMs;
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, map: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await map(values[index], index);
    }
  }));
  return output;
}

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
    readOnly: !!spec.readOnly,
  };
}

async function stopDbTunnel(connectionKey: string): Promise<void> {
  const tunnelId = dbTunnelByConnection.get(connectionKey);
  if (!tunnelId) return;
  dbTunnelByConnection.delete(connectionKey);
  sharedTunnelManager().stop(tunnelId);
}

async function openDbTunnel(spec: DbConnectSpec): Promise<{ config: DbConnectConfig; tunnelId?: string }> {
  if (!spec.sshTunnel) return { config: toConfig(spec) };
  if (spec.connectionString) {
    throw new ApiError('db_ssh_url_unsupported', 400, 'SSH tunnelling requires host/port fields; URL mode cannot be rewritten safely.');
  }
  const tunnel = await sharedTunnelManager().start({
    spec: spec.sshTunnel.spec,
    kind: 'local',
    bindHost: '127.0.0.1',
    bindPort: 0,
    destHost: spec.sshTunnel.remoteHost,
    destPort: spec.sshTunnel.remotePort,
  });
  return {
    tunnelId: tunnel.id,
    config: toConfig({ ...spec, host: tunnel.bindHost, port: tunnel.bindPort, sshTunnel: undefined }),
  };
}

// Read-vs-write SQL classification (stripSqlNoise/isReadStatement/…) moved to
// `@mcp/db-drivers` (`sql/read-guard.ts`) so the agent `db_*` tools share the
// exact same read-only valve. Imported above.

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

  async function loadCatalog(connectionId: string, force = false): Promise<DbCatalogSnapshot> {
    const key = keyFor(connectionId);
    const cached = catalogCache.get(key);
    if (!force && cached && Date.now() - cached.refreshedAt < CATALOG_TTL_MS) return cached;
    const driver = requireDriver(connectionId);
    const schemas = await driver.listSchemas();
    const objects: DbCatalogSnapshot['objects'] = schemas.map((name) => ({ kind: 'schema', name }));
    const groups = await mapConcurrent(schemas, 4, async (schema) => {
      const [tables, functions, sequences] = await Promise.all([
        driver.listTables(schema),
        driver.listObjects('functions', schema).catch(() => []),
        driver.listObjects('sequences', schema).catch(() => []),
      ]);
      return { schema, tables, functions, sequences };
    });
    for (const { schema, tables, functions, sequences } of groups) {
      objects.push(...tables.map((table) => ({ kind: table.kind, name: table.name, schema } as const)));
      objects.push(...functions.map((name) => ({ kind: 'function' as const, name, schema })));
      objects.push(...sequences.map((name) => ({ kind: 'sequence' as const, name, schema })));
    }
    const snapshot = { objects, refreshedAt: Date.now() };
    catalogCache.set(key, snapshot);
    return snapshot;
  }

  /** Guard a relational-only op (SQL/tables/DDL) against a document/key-value connection. */
  function assertRelational(connectionId: string, op: string): void {
    const kind = mgr.getMeta(keyFor(connectionId))?.kind ?? 'relational';
    if (kind !== 'relational') {
      throw new ApiError('db_op_unsupported', 422, `${op} is not supported for a ${kind} store — use runCommand.`);
    }
  }

  async function materializeDdl(
    connectionId: string,
    op: DbDdlOp,
    spec: DbDdlSpec,
  ): Promise<{ statements: string[]; rebuild: boolean }> {
    const engine = requireEngine(connectionId);
    const driver = requireDriver(connectionId);
    const rebuild = engine === 'sqlite' && op === 'alter' && !!spec.alter && sqliteAlterNeedsRebuild(spec.alter);
    if (!rebuild) return { statements: buildDdl(engine, op, spec), rebuild: false };

    const alter = spec.alter!;
    const info = await driver.describeTable(alter.schema ?? '', alter.table);
    // TableInfo cannot faithfully reproduce these SQLite constructs. Refuse the
    // rebuild instead of quietly dropping constraints or generated behaviour.
    const ddlRow = await driver.runQuery(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, { params: [alter.table] });
    const createSql = String(ddlRow.rows[0]?.sql ?? '');
    if (/\bCHECK\s*\(|\bGENERATED\s+ALWAYS\b|\bWITHOUT\s+ROWID\b/i.test(createSql)) {
      throw new ApiError('db_ddl_unsupported', 422, 'This table uses CHECK constraints, generated columns or WITHOUT ROWID — in-place column/FK changes would drop them. Recreate the table manually.');
    }
    const triggerRows = await driver.runQuery(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`, { params: [alter.table] });
    const triggers = triggerRows.rows.map((row) => String(row.sql)).filter((sql) => sql && sql !== 'null');
    return { statements: buildSqliteRebuild(info, alter, { triggers }), rebuild: true };
  }

  function assertExecutableDdl(statements: string[]): void {
    if (statements.every((statement) => /^\s*--/.test(statement))) {
      throw new ApiError('db_ddl_unsupported', 422, statements.join('\n').replace(/^\s*--\s?/gm, '') || 'Unsupported DDL.');
    }
  }

  async function executeDdlStatements(driver: DatabaseDriver, statements: string[], rebuild: boolean) {
    assertExecutableDdl(statements);
    let result;
    if (rebuild) {
      try {
        for (const statement of statements) {
          if (/^\s*--/.test(statement)) continue;
          result = await driver.runQuery(statement);
        }
      } catch (error) {
        await driver.runQuery('ROLLBACK').catch(() => undefined);
        await driver.runQuery('PRAGMA foreign_keys=ON').catch(() => undefined);
        throw error;
      }
      return result;
    }
    const executable = statements.filter((statement) => !/^\s*--/.test(statement));
    if (driver.runBatch) return driver.runBatch(executable);
    for (const statement of executable) result = await driver.runQuery(statement);
    return result;
  }

  return {
    async testConnection({ spec }) {
      let tunnelId: string | undefined;
      let driver: DatabaseDriver | undefined;
      try {
        const opened = await openDbTunnel(spec);
        tunnelId = opened.tunnelId;
        driver = await createDriver(opened.config);
        const { serverVersion } = await driver.testConnection();
        return { ok: true, serverVersion };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        await driver?.close().catch(() => void 0);
        if (tunnelId) sharedTunnelManager().stop(tunnelId);
      }
    },

    async connect({ spec }) {
      const key = keyFor(spec.connectionId);
      // A fresh Connect uses fresh credentials — drop any prior pool first.
      await mgr.closeKey(key);
      await stopDbTunnel(key);
      catalogCache.delete(key);
      const opened = await openDbTunnel(spec);
      if (opened.tunnelId) dbTunnelByConnection.set(key, opened.tunnelId);
      let driver: DatabaseDriver;
      try {
        driver = await mgr.acquire(key, opened.config, { pinned: true });
      } catch (error) {
        await stopDbTunnel(key);
        throw error;
      }
      const kind: DbEngineKind = driver.kind ?? 'relational';
      mgr.setMeta(key, { engine: spec.engine, readOnly: !!spec.readOnly, kind });
      let serverVersion: string | undefined;
      try {
        serverVersion = (await driver.testConnection()).serverVersion;
      } catch (err) {
        // Connect failed at ping — tear the pool down so we don't leak it.
        await mgr.closeKey(key);
        await stopDbTunnel(key);
        throw new ApiError('db_connect_failed', 502, err instanceof Error ? err.message : String(err));
      }
      return { sessionToken: `dbsess:${spec.connectionId}`, serverVersion, kind };
    },

    async disconnect({ connectionId }) {
      const key = keyFor(connectionId);
      await mgr.closeKey(key);
      await stopDbTunnel(key);
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

    async catalog({ connectionId, force }) {
      assertRelational(connectionId, 'catalog');
      return loadCatalog(connectionId, force);
    },

    async searchCatalog({ connectionId, query, limit }) {
      assertRelational(connectionId, 'searchCatalog');
      const normalized = query.trim().toLocaleLowerCase();
      if (!normalized) return [];
      const snapshot = await loadCatalog(connectionId);
      const max = Math.min(Math.max(limit ?? 100, 1), 500);
      return snapshot.objects
        .filter((object) => `${object.schema ?? ''}.${object.name}`.toLocaleLowerCase().includes(normalized))
        .sort((left, right) => {
          const leftExact = left.name.toLocaleLowerCase() === normalized ? 0 : 1;
          const rightExact = right.name.toLocaleLowerCase() === normalized ? 0 : 1;
          return leftExact - rightExact || left.name.localeCompare(right.name);
        })
        .slice(0, max);
    },

    async schemaSnapshot({ connectionId, schema }) {
      assertRelational(connectionId, 'schemaSnapshot');
      const driver = requireDriver(connectionId);
      const refs = (await driver.listTables(schema)).filter((ref) => ref.kind === 'table');
      const tables = await mapConcurrent(refs, 6, (ref) => driver.describeTable(ref.schema || schema, ref.name) as Promise<DbTableInfo>);
      return { schema, tables, capturedAt: Date.now() };
    },

    async describeTable({ connectionId, schema, table }) {
      const info = await requireDriver(connectionId).describeTable(schema, table);
      return info as DbTableInfo;
    },

    async incomingForeignKeys({ connectionId, schema, table }) {
      assertRelational(connectionId, 'incomingForeignKeys');
      const driver = requireDriver(connectionId);
      if (!driver.listIncomingForeignKeys) return [];
      return driver.listIncomingForeignKeys(schema, table);
    },

    async tableRows({ connectionId, schema, table, limit, offset, orderBy, where }) {
      const started = Date.now();
      const res = await requireDriver(connectionId).tablePreview(schema, table, { limit, offset, orderBy, where });
      return { ...res, durationMs: Date.now() - started };
    },

    async listObjects({ connectionId, kind, schema, table }) {
      return requireDriver(connectionId).listObjects(kind, schema, table);
    },

    async generateSql({ connectionId, schema, table, kind }) {
      assertRelational(connectionId, 'generateSql');
      const driver = requireDriver(connectionId);
      const engine = requireEngine(connectionId);
      const rel = quoteRelation(engine, schema, table);
      if (kind === 'select') return { sql: buildSelectTemplate(engine, rel) };
      if (kind === 'truncate') {
        // SQLite has no TRUNCATE — DELETE FROM is the equivalent.
        return { sql: engine === 'sqlite' ? `DELETE FROM ${rel};` : `TRUNCATE TABLE ${rel};` };
      }
      // Default the schema for relational engines so describeTable doesn't match
      // zero rows (which would emit a column-less CREATE).
      const effSchema = schema ?? defaultSchemaFor(engine);
      const info = await driver.describeTable(effSchema ?? '', table);
      if (kind === 'insert') {
        const cols = info.columns.filter((c) => !c.isAutoIncrement);
        if (cols.length === 0) {
          // Every column is auto-increment/identity → an all-defaults insert.
          // MySQL/MariaDB use `() VALUES ()`; the rest use `DEFAULT VALUES`.
          return { sql: engine === 'mysql' || engine === 'mariadb' ? `INSERT INTO ${rel} () VALUES ();` : `INSERT INTO ${rel} DEFAULT VALUES;` };
        }
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

    async query({ connectionId, sql, params, maxRows, timeoutMs: requestedTimeoutMs, queryId, schema }) {
      const driver = requireDriver(connectionId);
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && !isReadStatement(sql)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — only SELECT statements are allowed.');
      }
      const timeoutMs = parseQueryTimeoutMs(requestedTimeoutMs);
      const controller = new AbortController();
      const inflightKey = queryId ? `${connectionId}:${queryId}` : null;
      if (inflightKey) inflight.set(inflightKey, controller);
      const started = Date.now();
      let timedOut = false;
      const timeout = timeoutMs == null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort(new Error(`query timed out after ${timeoutMs}ms`));
          }, timeoutMs);
      try {
        const result = await driver.runQuery(sql, { params, maxRows, timeoutMs, schema, signal: controller.signal });
        return { ...result, durationMs: Date.now() - started };
      } catch (err) {
        if (timedOut) {
          throw new ApiError('db_query_timeout', 408, `Query timed out after ${timeoutMs}ms.`);
        }
        throw err;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (inflightKey) inflight.delete(inflightKey);
      }
    },

    async queryBatch({ connectionId, statements, maxRows, timeoutMs: requestedTimeoutMs, queryId, schema }) {
      assertRelational(connectionId, 'queryBatch');
      if (statements.length === 0) return { results: [], durationMs: 0 };
      const readOnly = mgr.getMeta(keyFor(connectionId))?.readOnly === true;
      if (readOnly && statements.some((statement) => !isReadStatement(statement.sql))) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — the atomic batch contains a write.');
      }
      const driver = requireDriver(connectionId);
      const engine = requireEngine(connectionId);
      const timeoutMs = parseQueryTimeoutMs(requestedTimeoutMs);
      const controller = new AbortController();
      const inflightKey = queryId ? `${connectionId}:${queryId}` : null;
      if (inflightKey) inflight.set(inflightKey, controller);
      let timedOut = false;
      const timeout = timeoutMs == null ? undefined : setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`query timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const scopeSql = schema
        ? engine === 'postgres'
          ? `SET LOCAL search_path TO ${quoteIdent(engine, schema)}`
          : engine === 'mysql' || engine === 'mariadb'
            ? `USE ${quoteIdent(engine, schema)}`
            : engine === 'oracle'
              ? `ALTER SESSION SET CURRENT_SCHEMA = ${quoteIdent(engine, schema)}`
              : null
        : null;
      const scoped = scopeSql ? [{ sql: scopeSql }, ...statements] : statements;
      const scopeOffset = scopeSql ? 1 : 0;
      const results: DbQueryResult[] = [];
      const started = Date.now();
      try {
        if (driver.runBatch && !readOnly) {
          await driver.runBatch(scoped, {
            signal: controller.signal,
            maxRows,
            onResult: (item, index) => {
              if (index >= scopeOffset) results.push(item as DbQueryResult);
            },
          });
        } else {
          // Read-only wrappers intentionally reject runBatch. Reads still execute
          // safely; they only lose the atomic/pinned guarantee because no writes exist.
          for (const statement of scoped) {
            const item = await driver.runQuery(statement.sql, {
              params: statement.params,
              maxRows,
              timeoutMs,
              signal: controller.signal,
            });
            if (statement !== scoped[0] || scopeOffset === 0) results.push(item as DbQueryResult);
          }
        }
        const durationMs = Date.now() - started;
        return {
          results: results.map((result) => ({ ...result, durationMs })),
          durationMs,
        };
      } catch (err) {
        if (timedOut) throw new ApiError('db_query_timeout', 408, `Query batch timed out after ${timeoutMs}ms.`);
        throw new ApiError(
          'db_query_batch_failed',
          422,
          `Statement ${Math.min(results.length + 1, statements.length)} failed; the transaction was rolled back. ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        if (timeout) clearTimeout(timeout);
        if (inflightKey) inflight.delete(inflightKey);
      }
    },

    async cancel({ connectionId, queryId }) {
      inflight.get(`${connectionId}:${queryId}`)?.abort();
    },

    async explain({ connectionId, sql }) {
      assertRelational(connectionId, 'explain');
      const engine = requireEngine(connectionId);
      // A trailing statement would EXECUTE (EXPLAIN binds only the first); refuse it.
      if (hasMultipleStatements(sql)) throw new ApiError('db_explain_multi', 400, 'Explain expects a single statement.');
      // On a read-only connection, only read statements may be explained (blocks
      // EXPLAIN ANALYZE of a write, which would run it).
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && !isReadStatement(sql)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — only read statements can be explained.');
      }
      const driver = requireDriver(connectionId);
      if (engine === 'mssql' && driver.explain) {
        const started = Date.now();
        const result = await driver.explain(sql, { maxRows: 2000 });
        return { ...result, durationMs: Date.now() - started };
      }
      const statement = engine === 'postgres'
        ? `EXPLAIN (FORMAT JSON) ${sql}`
        : engine === 'mysql' || engine === 'mariadb'
          ? `EXPLAIN FORMAT=JSON ${sql}`
          : buildExplainStatement(engine, sql);
      if (!statement) throw new ApiError('db_explain_unsupported', 422, 'Execution plans are not supported by this driver.');
      const started = Date.now();
      let res = await driver.runQuery(statement, { maxRows: 2000 });
      if (engine === 'oracle') {
        res = await driver.runQuery(`SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'TYPICAL'))`, { maxRows: 2000 });
      }
      return { ...res, durationMs: Date.now() - started };
    },

    async editRow({ connectionId, op, schema, table, pk, values, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'editRow');
      const engine = requireEngine(connectionId);
      const change: RowChange = { op, schema, table, pk, values };
      const built = buildDml(engine, change);
      if (dryRun) return { sql: built.display };
      const result = await requireDriver(connectionId).runQuery(built.sql, { params: built.params });
      return { sql: built.display, result };
    },

    async editRows({ connectionId, changes, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'editRows');
      if (changes.length === 0) return { sql: '', applied: 0, results: [] };
      const engine = requireEngine(connectionId);
      const driver = requireDriver(connectionId);
      const built = changes.map((change) => buildDml(engine, change));
      const sql = built.map((statement) => statement.display).join(';\n') + ';';
      if (dryRun) return { sql, applied: 0 };
      const results: DbQueryResult[] = [];
      let result;
      if (driver.runBatch) {
        result = await driver.runBatch(
          built.map((statement) => ({ sql: statement.sql, params: statement.params })),
          { onResult: (item) => results.push(item as DbQueryResult) },
        );
      } else {
        // All bundled relational drivers implement runBatch. Keep a safe fallback
        // for third-party drivers while preserving parameterization.
        for (const statement of built) {
          result = await driver.runQuery(statement.sql, { params: statement.params });
          results.push(result as DbQueryResult);
        }
      }
      return { sql, result, results, applied: changes.length };
    },

    async ddl({ connectionId, op, spec, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'ddl');
      const driver = requireDriver(connectionId);
      const { statements, rebuild } = await materializeDdl(connectionId, op, spec);
      const sql = statements.join(';\n') + ';';
      if (dryRun) return { sql };
      const result = await executeDdlStatements(driver, statements, rebuild);
      catalogCache.delete(keyFor(connectionId));
      return { sql, result };
    },

    async migration({ connectionId, changes, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'migration');
      const engine = requireEngine(connectionId);
      const driver = requireDriver(connectionId);
      const prepared = [] as Array<{ statements: string[]; rebuild: boolean }>;
      for (const change of changes) prepared.push(await materializeDdl(connectionId, change.op, change.spec));
      for (const item of prepared) assertExecutableDdl(item.statements);
      const sql = prepared
        .map((item, index) => `-- Change ${index + 1}\n${item.statements.join(';\n')};`)
        .join('\n\n');
      const atomic = !['mysql', 'mariadb', 'oracle'].includes(engine)
        && !prepared.some((item) => item.rebuild)
        && !!driver.runBatch;
      if (dryRun || prepared.length === 0) return { sql, applied: 0, atomic };

      let result;
      if (prepared.some((item) => item.rebuild)) {
        // A SQLite rebuild owns its BEGIN/COMMIT boundary. Keep each rebuild safe,
        // while accurately reporting that the whole multi-change migration is not
        // one atomic unit.
        for (const change of changes) {
          const current = await materializeDdl(connectionId, change.op, change.spec);
          result = await executeDdlStatements(driver, current.statements, current.rebuild);
        }
      } else {
        const statements = prepared.flatMap((item) => item.statements.filter((statement) => !/^\s*--/.test(statement)));
        result = driver.runBatch
          ? await driver.runBatch(statements)
          : await executeDdlStatements(driver, statements, false);
      }
      catalogCache.delete(keyFor(connectionId));
      return { sql, result, applied: changes.length, atomic };
    },

    async *exportStream({ connectionId, schema, table, batchRows }) {
      assertRelational(connectionId, 'exportStream');
      const driver = requireDriver(connectionId);
      // Page with the engine-correct, quoted SELECT * (tablePreview); the client
      // formats + writes each batch, so a huge table never lands in memory whole.
      const page = Math.min(Math.max(batchRows ?? 1000, 100), 10_000);
      // OFFSET paging without a stable ORDER BY can skip/duplicate rows across
      // pages — order by the primary key (fallback: first column).
      const info = await driver.describeTable(schema ?? '', table).catch(() => null);
      const pkCol = info?.columns.find((c) => c.isPrimaryKey)?.name ?? info?.columns[0]?.name;
      const orderBy = pkCol ? ({ column: pkCol, dir: 'asc' as const }) : undefined;
      let offset = 0;
      let total = 0;
      let columns: string[] = [];
      for (;;) {
        const res = await driver.tablePreview(schema ?? '', table, { limit: page, offset, orderBy });
        if (columns.length === 0) {
          columns = res.fields.length > 0 ? res.fields.map((f) => f.name) : res.rows[0] ? Object.keys(res.rows[0]) : [];
        }
        total += res.rows.length;
        offset += res.rows.length;
        // tablePreview fetches limit+1 internally, so `truncated` means more rows.
        const done = !res.truncated;
        yield { columns, rows: res.rows, total, done };
        if (done) break;
      }
    },

    async *dumpStream({ connectionId, schema, tables, includeData, batchRows }) {
      assertRelational(connectionId, 'dumpStream');
      const engine = requireEngine(connectionId);
      const driver = requireDriver(connectionId);
      const effSchema = schema ?? defaultSchemaFor(engine);
      // Selected tables, or every base table in the schema (skip views).
      const list = tables && tables.length
        ? tables
        : (await driver.listTables(effSchema)).filter((t) => t.kind === 'table').map((t) => t.name);
      const page = Math.min(Math.max(batchRows ?? 1000, 100), 10_000);
      let total = 0;
      yield { sql: `-- Dump of ${effSchema ?? 'database'} — ${list.length} table(s)\n`, total, done: false };
      for (const table of list) {
        const info = await driver.describeTable(effSchema ?? '', table);
        const columns: ColumnSpec[] = info.columns.map((c) => ({
          name: c.name, type: c.dataType, nullable: c.nullable,
          default: c.defaultValue ?? null, primaryKey: c.isPrimaryKey, autoIncrement: c.isAutoIncrement,
        }));
        const createSql = buildDdl(engine, 'create', { create: { schema: effSchema, table, columns } }).join(';\n') + ';\n';
        yield { sql: `\n-- Table: ${table}\n${createSql}`, table, total, done: false };
        if (includeData === false) continue;
        const colNames = info.columns.map((c) => c.name);
        // Stable ORDER BY (PK, else first column) so OFFSET paging can't skip/dupe.
        const pkCol = info.columns.find((c) => c.isPrimaryKey)?.name ?? info.columns[0]?.name;
        const orderBy = pkCol ? ({ column: pkCol, dir: 'asc' as const }) : undefined;
        let offset = 0;
        for (;;) {
          const res = await driver.tablePreview(effSchema ?? '', table, { limit: page, offset, orderBy });
          if (res.rows.length > 0) {
            total += res.rows.length;
            yield { sql: insertLiteral(engine, effSchema, table, colNames, res.rows) + '\n', table, total, done: false };
          }
          offset += res.rows.length;
          if (!res.truncated) break; // tablePreview fetches limit+1 → truncated = more rows
        }
      }
      yield { sql: '', total, done: true };
    },

    async runScript({ connectionId, statements }) {
      assertRelational(connectionId, 'runScript');
      const driver = requireDriver(connectionId);
      if (mgr.getMeta(keyFor(connectionId))?.readOnly) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — cannot run a restore script.');
      }
      const toRun = statements.filter((s) => s && s.trim() && !/^\s*--/.test(s));
      if (toRun.length === 0) return { rows: [], rowCount: 0, fields: [] };
      // One pinned connection + transaction where the engine allows DDL rollback.
      if (driver.runBatch) return driver.runBatch(toRun);
      let result = { rows: [], rowCount: 0, fields: [] } as Awaited<ReturnType<typeof driver.runQuery>>;
      for (const stmt of toRun) result = await driver.runQuery(stmt);
      return result;
    },

    async runCommand({ connectionId, command, maxRows }) {
      const driver = requireDriver(connectionId);
      if (!driver.runCommand) {
        throw new ApiError('db_op_unsupported', 422, 'This connection does not support commands (relational — use query).');
      }
      // The SQL read-only valve can't classify Mongo/Redis — use the per-kind one.
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && isWriteCommand(command)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — write commands are blocked.');
      }
      return driver.runCommand(command, { maxRows });
    },

    async driverStatus() {
      return listDbDriverStatus();
    },

    async *installDriverStream({ engine }) {
      yield* installDbDriver(engine);
    },
  };
}
