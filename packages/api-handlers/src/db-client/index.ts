import { exportTableRows } from './export.js';
import { readCatalogPage } from './catalog.js';
import { applyCheckedRowEdits } from './checked-row-edits.js';
import { beginDatabaseJob, readDatabaseJob, cancelDatabaseJob } from './jobs.js';
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
  DbBatchError,
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
import { clampMaxRows, clampOffset, clampPageLimit, parseQueryTimeoutMs } from './limits.js';

export {
  MAX_QUERY_TIMEOUT_MS,
  MAX_RESULT_ROWS,
  MIN_QUERY_TIMEOUT_MS,
  clampMaxRows,
  parseQueryTimeoutMs,
} from './limits.js';

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
const catalogRevisions = new Map<string, number>();
/**
 * In-flight catalog builds, so concurrent callers share ONE crawl. Building a
 * catalog is `listSchemas` + three list calls per schema; the tree search fires
 * one `searchCatalog` per connected connection on a cold cache, and the query
 * console asks for the same catalog when a tab opens. Without this, opening a
 * console while typing in the search box crawled the whole database twice.
 */
const catalogInflight = new Map<string, Promise<DbCatalogSnapshot>>();
const dbTunnelByConnection = new Map<string, string>();
const CATALOG_TTL_MS = 5 * 60_000;

/** Forget everything cached for a connection (disconnect / reconnect / DDL). */
function dropCaches(key: string): void {
  catalogRevisions.set(key, (catalogRevisions.get(key) ?? 0) + 1);
  for (const cacheKey of catalogCache.keys()) if (cacheKey.startsWith(key + '\0')) catalogCache.delete(cacheKey);
  for (const cacheKey of catalogInflight.keys()) if (cacheKey.startsWith(key + '\0')) catalogInflight.delete(cacheKey);
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

  async function loadCatalog(connectionId: string, opts: { force?: boolean; schema?: string; query?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<DbCatalogSnapshot> {
    const base = keyFor(connectionId);
    if (opts.force) dropCaches(base);
    const revision = catalogRevisions.get(base) ?? 0;
    const key = base + '\0' + JSON.stringify([revision, opts.schema, opts.query, opts.cursor, opts.limit]);
    signal?.throwIfAborted();
    const cached = catalogCache.get(key);
    if (cached && Date.now() - cached.refreshedAt < CATALOG_TTL_MS) return cached;
    // Cancellable consumers own their work: cancellation cannot abort a sibling.
    const running = !signal && catalogInflight.get(key);
    if (running) return running;
    const pending = readCatalogPage(requireDriver(connectionId), requireEngine(connectionId), base + ':' + revision, opts, signal).then(snapshot => {
      if ((catalogRevisions.get(base) ?? 0) === revision) {
        if (catalogCache.size >= 256) catalogCache.delete(catalogCache.keys().next().value!);
        catalogCache.set(key, snapshot);
      }
      return snapshot;
    }).finally(() => { if (catalogInflight.get(key) === pending) catalogInflight.delete(key); });
    if (!signal) catalogInflight.set(key, pending);
    return pending;
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
      dropCaches(key);
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
      // The caches are module-scoped and outlive the pool: without this, every
      // connect/disconnect cycle leaves a full catalog snapshot behind for the
      // life of the process.
      dropCaches(key);
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

    async catalog({ connectionId, ...opts }, ctx) {
      assertRelational(connectionId, 'catalog');
      return loadCatalog(connectionId, opts, ctx.signal);
    },

    async searchCatalog({ connectionId, query, limit }, ctx) {
      assertRelational(connectionId, 'searchCatalog');
      const normalized = query.trim().toLocaleLowerCase();
      if (!normalized) return [];
      const snapshot = await loadCatalog(connectionId, { query, limit }, ctx.signal);
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
      const res = await requireDriver(connectionId).tablePreview(schema, table, {
        limit: clampPageLimit(limit),
        offset: clampOffset(offset),
        orderBy,
        where,
      });
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

    async query({ connectionId, sql, params, maxRows: requestedMaxRows, timeoutMs: requestedTimeoutMs, queryId, schema }, ctx) {
      const driver = requireDriver(connectionId);
      const maxRows = clampMaxRows(requestedMaxRows);
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && !isReadStatement(sql)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — only SELECT statements are allowed.');
      }
      const timeoutMs = parseQueryTimeoutMs(requestedTimeoutMs);
      const controller = new AbortController();
      ctx.signal?.throwIfAborted();
      const inflightKey = queryId ? JSON.stringify([connectionId, queryId]) : null;
      if (inflightKey && inflight.has(inflightKey)) throw new ApiError('db_query_already_running', 409, 'This queryId is already running on this connection.');
      if (inflightKey) inflight.set(inflightKey, controller);
      const abort = () => controller.abort(ctx.signal.reason);
      ctx.signal?.addEventListener('abort', abort, { once: true });
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
          throw new ApiError('db_query_timeout', 408, `Query timed out after ${timeoutMs}ms.`, { effectOutcome: isReadStatement(sql) ? 'not_started' : 'unknown' });
        }
        if (controller.signal.aborted) throw new ApiError('db_query_cancelled', 499, 'Query cancellation completed.', { effectOutcome: isReadStatement(sql) ? 'not_started' : 'unknown' });
        if ((err as { effectOutcome?: string })?.effectOutcome === 'unknown') throw new ApiError('db_query_outcome_unknown', 422, 'The database did not confirm the result. Reconcile before retrying.', { effectOutcome: 'unknown' });
        throw err;
      } finally {
        ctx.signal?.removeEventListener('abort', abort);
        if (timeout) clearTimeout(timeout);
        if (inflightKey) inflight.delete(inflightKey);
      }
    },

    async queryBatch({ connectionId, statements, maxRows: requestedMaxRows, timeoutMs: requestedTimeoutMs, queryId, schema }, ctx) {
      assertRelational(connectionId, 'queryBatch');
      if (statements.length === 0) return { results: [], durationMs: 0 };
      const maxRows = clampMaxRows(requestedMaxRows);
      const readOnly = mgr.getMeta(keyFor(connectionId))?.readOnly === true;
      if (readOnly && statements.some((statement) => !isReadStatement(statement.sql))) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — the atomic batch contains a write.');
      }
      const driver = requireDriver(connectionId);
      const engine = requireEngine(connectionId);
      const timeoutMs = parseQueryTimeoutMs(requestedTimeoutMs);
      const controller = new AbortController();
      ctx.signal?.throwIfAborted();
      const inflightKey = queryId ? JSON.stringify([connectionId, queryId]) : null;
      if (inflightKey && inflight.has(inflightKey)) throw new ApiError('db_query_already_running', 409, 'This queryId is already running on this connection.');
      if (inflightKey) inflight.set(inflightKey, controller);
      const abort = () => controller.abort(ctx.signal.reason);
      ctx.signal?.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      const timeout = timeoutMs == null ? undefined : setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`query timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const results: DbQueryResult[] = [];
      const started = Date.now();
      try {
        let outcome;
        if (driver.runBatch) {
          const last = await driver.runBatch(statements, {
            signal: controller.signal,
            maxRows,
            timeoutMs,
            schema,
            onResult: (item) => {
              results.push(item as DbQueryResult);
            },
          });
          outcome = last.batchOutcome;
        } else {
          if (!readOnly) throw new ApiError('db_batch_unsupported', 422, 'Driver cannot execute a pinned transaction batch.');
          for (const statement of statements) {
            controller.signal.throwIfAborted();
            const item = await driver.runQuery(statement.sql, {
              params: statement.params,
              maxRows,
              timeoutMs,
              signal: controller.signal,
              schema,
            });
            results.push(item as DbQueryResult);
          }
          outcome = { state: 'completed' as const, effect: 'not_started' as const, atomicity: 'best_effort' as const, completedStatements: results.length };
        }
        const durationMs = Date.now() - started;
        return {
          results: results.map((result) => ({ ...result, durationMs })),
          durationMs,
          outcome,
        };
      } catch (err) {
        const outcome = err instanceof DbBatchError ? err.outcome : {
          state: controller.signal.aborted ? 'cancelled' : 'failed', effect: 'unknown',
          atomicity: 'best_effort', completedStatements: results.length,
        };
        if (timedOut) throw new ApiError('db_query_timeout', 408, `Query batch timed out after ${timeoutMs}ms. Effect: ${outcome.effect}.`, { outcome });
        throw new ApiError(
          'db_query_batch_failed',
          422,
          `Statement ${Math.min(results.length + 1, statements.length)} failed. Effect: ${outcome.effect.replaceAll('_', ' ')}. ${err instanceof Error ? err.message : String(err)}`,
          { outcome },
        );
      } finally {
        ctx.signal?.removeEventListener('abort', abort);
        if (timeout) clearTimeout(timeout);
        if (inflightKey) inflight.delete(inflightKey);
      }
    },

    async cancel({ connectionId, queryId }) {
      inflight.get(JSON.stringify([connectionId, queryId]))?.abort();
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

    async editRow({ connectionId, op, schema, table, pk, values, original, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'editRow');
      return applyCheckedRowEdits(requireDriver(connectionId), requireEngine(connectionId), [{ op, schema, table, pk, values, original }], dryRun);
    },

    async editRows({ connectionId, changes, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'editRows');
      return applyCheckedRowEdits(requireDriver(connectionId), requireEngine(connectionId), changes, dryRun);
    },

    async ddl({ connectionId, op, spec, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'ddl');
      const driver = requireDriver(connectionId);
      const { statements, rebuild } = await materializeDdl(connectionId, op, spec);
      const sql = statements.join(';\n') + ';';
      if (dryRun) return { sql };
      const result = await executeDdlStatements(driver, statements, rebuild);
      dropCaches(keyFor(connectionId));
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
      dropCaches(keyFor(connectionId));
      return { sql, result, applied: changes.length, atomic };
    },

    async jobStatus({ connectionId, jobId }) {
      return readDatabaseJob(keyFor(connectionId), jobId);
    },
    async cancelJob({ connectionId, jobId }) {
      return cancelDatabaseJob(keyFor(connectionId), jobId);
    },
    async *exportStream({ connectionId, schema, table, batchRows, jobId }, ctx) {
      assertRelational(connectionId, 'exportStream');
      const driver = requireDriver(connectionId);
      const job = beginDatabaseJob(keyFor(connectionId), 'export', jobId, ctx.signal);
      let terminal = false;
      try {
        for await (const frame of exportTableRows(driver, requireEngine(connectionId), schema, table, batchRows, job.signal)) {
          job.update({ completed: frame.total });
          if (frame.done) { job.finish({ state: 'completed', total: frame.total }); terminal = true; }
          yield { ...frame, jobId: job.id };
        }
      } catch (error) {
        terminal = true; job.finish({ state: job.signal.aborted ? 'cancelled' : 'failed' }); throw error;
      } finally { if (!terminal) job.finish({ state: 'cancelled' }); }
    },

    async *dumpStream({ connectionId, schema, tables, includeData, batchRows, jobId }, ctx) {
      assertRelational(connectionId, 'dumpStream');
      const engine = requireEngine(connectionId);
      const driver = requireDriver(connectionId);
      const job = beginDatabaseJob(keyFor(connectionId), 'export', jobId, ctx.signal);
      let terminal = false;
      try {
      const effSchema = schema ?? defaultSchemaFor(engine);
      job.signal?.throwIfAborted();
      // Selected tables, or every base table in the schema (skip views).
      const list = tables && tables.length
        ? tables
        : (await driver.listTables(effSchema)).filter((t) => t.kind === 'table').map((t) => t.name);
      const page = Math.min(Math.max(batchRows ?? 1000, 100), 10_000);
      let total = 0;
      yield { sql: `-- Dump of ${effSchema ?? 'database'} — ${list.length} table(s)\n-- Consistency: best_effort. Concurrent changes are not a snapshot.\n`, total, done: false, consistency: 'best_effort' };
      for (const table of list) {
        job.signal?.throwIfAborted();
        const info = await driver.describeTable(effSchema ?? '', table);
        const columns: ColumnSpec[] = info.columns.map((c) => ({
          name: c.name, type: c.dataType, nullable: c.nullable,
          default: c.defaultValue ?? null, primaryKey: c.isPrimaryKey, autoIncrement: c.isAutoIncrement,
        }));
        const createSql = buildDdl(engine, 'create', { create: { schema: effSchema, table, columns } }).join(';\n') + ';\n';
        yield { sql: `\n-- Table: ${table}\n${createSql}`, table, total, done: false };
        if (includeData === false) continue;
        const colNames = info.columns.map((c) => c.name);
        for await (const frame of exportTableRows(driver, engine, effSchema, table, page, job.signal)) {
          if (frame.rows.length) {
            total += frame.rows.length; job.update({ completed: total });
            yield { sql: insertLiteral(engine, effSchema, table, colNames, frame.rows) + '\n', table, total, done: false, consistency: 'best_effort' };
          }
        }
      }
      job.finish({ state: 'completed', total, completed: total }); terminal = true;
      yield { sql: '', total, done: true };
      } catch (error) { terminal = true; job.finish({ state: job.signal.aborted ? 'cancelled' : 'failed' }); throw error; }
      finally { if (!terminal) job.finish({ state: 'cancelled' }); }
    },

    async runScript({ connectionId, statements, jobId }, ctx) {
      assertRelational(connectionId, 'runScript');
      const driver = requireDriver(connectionId);
      if (mgr.getMeta(keyFor(connectionId))?.readOnly) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — cannot run a restore script.');
      }
      const toRun = statements.filter(s => s && s.trim());
      if (toRun.length > 10_000 || Buffer.byteLength(toRun.join('\n')) > 16 * 1024 * 1024) throw new ApiError('db_import_budget', 413, 'Import exceeds 10000 statements or 16 MiB. Split the import into reviewed batches.');
      ctx.signal?.throwIfAborted();
      if (toRun.length === 0) return { rows: [], rowCount: 0, fields: [] };
      // One pinned connection + transaction where the engine allows DDL rollback.
      if (!driver.runBatch) throw new ApiError('db_batch_unsupported', 422, 'This driver cannot execute a pinned restore batch.');
      const job = beginDatabaseJob(keyFor(connectionId), 'import', jobId, ctx.signal);
      job.update({ total: toRun.length });
      try {
        const result = await driver.runBatch(toRun, { signal: job.signal, timeoutMs: 60_000,
          onResult: (_result, index) => job.update({ completed: index + 1, effect: 'unknown' }) });
        job.finish({ state: 'completed', effect: 'confirmed', completed: toRun.length });
        return { ...result, jobId: job.id };
      }
      catch (error) {
        const effect = error instanceof DbBatchError && (error.outcome.effect === 'rolled_back' || error.outcome.effect === 'not_started') ? 'none' : 'unknown';
        job.finish({ state: job.signal.aborted ? 'cancelled' : 'failed', effect });
        if (error instanceof DbBatchError) throw new ApiError('db_import_failed', 422, error.message, { outcome: error.outcome, jobId: job.id });
        throw error;
      } finally { dropCaches(keyFor(connectionId)); }
    },

    async runCommand({ connectionId, command, maxRows: requestedMaxRows }, ctx) {
      const driver = requireDriver(connectionId);
      const maxRows = clampMaxRows(requestedMaxRows);
      if (!driver.runCommand) {
        throw new ApiError('db_op_unsupported', 422, 'This connection does not support commands (relational — use query).');
      }
      // The SQL read-only valve can't classify Mongo/Redis — use the per-kind one.
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && isWriteCommand(command)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — write commands are blocked.');
      }
      return driver.runCommand(command, { maxRows, signal: ctx.signal, timeoutMs: 30_000 });
    },

    async driverStatus() {
      return listDbDriverStatus();
    },

    async *installDriverStream({ engine }) {
      yield* installDbDriver(engine);
    },
  };
}
