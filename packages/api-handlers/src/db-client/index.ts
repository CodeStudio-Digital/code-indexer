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

import { ApiError, type DbClientApi, type DbConnectSpec, type DbEngineKind, type DbTableInfo } from '@mcp/api-bus';
import {
  buildDdl,
  buildDml,
  buildSqliteRebuild,
  sqliteAlterNeedsRebuild,
  createDriver,
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
  type RowChange,
} from '@mcp/db-drivers';
import { installDbDriver, listDbDriverStatus } from '@mcp/services/db/driver-installer.js';
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

  /** Guard a relational-only op (SQL/tables/DDL) against a document/key-value connection. */
  function assertRelational(connectionId: string, op: string): void {
    const kind = mgr.getMeta(keyFor(connectionId))?.kind ?? 'relational';
    if (kind !== 'relational') {
      throw new ApiError('db_op_unsupported', 422, `${op} is not supported for a ${kind} store — use runCommand.`);
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
      const kind: DbEngineKind = driver.kind ?? 'relational';
      mgr.setMeta(key, { engine: spec.engine, readOnly: !!spec.readOnly, kind });
      let serverVersion: string | undefined;
      try {
        serverVersion = (await driver.testConnection()).serverVersion;
      } catch (err) {
        // Connect failed at ping — tear the pool down so we don't leak it.
        await mgr.closeKey(key);
        throw new ApiError('db_connect_failed', 502, err instanceof Error ? err.message : String(err));
      }
      return { sessionToken: `dbsess:${spec.connectionId}`, serverVersion, kind };
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
      assertRelational(connectionId, 'explain');
      const engine = requireEngine(connectionId);
      // A trailing statement would EXECUTE (EXPLAIN binds only the first); refuse it.
      if (hasMultipleStatements(sql)) throw new ApiError('db_explain_multi', 400, 'Explain expects a single statement.');
      // On a read-only connection, only read statements may be explained (blocks
      // EXPLAIN ANALYZE of a write, which would run it).
      if (mgr.getMeta(keyFor(connectionId))?.readOnly && !isReadStatement(sql)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — only read statements can be explained.');
      }
      // SQL Server has no single-statement EXPLAIN; SHOWPLAN is a session toggle
      // that would leak into the pooled connection, so skip it cleanly.
      if (engine === 'mssql') throw new ApiError('db_explain_unsupported', 422, 'Execution plans are not yet supported for SQL Server in this client.');
      const prefix = engine === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
      const started = Date.now();
      const res = await requireDriver(connectionId).runQuery(prefix + sql, { maxRows: 2000 });
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

    async ddl({ connectionId, op, spec, dryRun }) {
      assertWritable(connectionId);
      assertRelational(connectionId, 'ddl');
      const engine = requireEngine(connectionId);
      const driver = requireDriver(connectionId);

      // SQLite can't modify a column or add/drop a FK in place — it needs a full
      // table rebuild built from the live schema. Detect that case and swap the
      // (comment-only) buildDdl output for the real rebuild statement list.
      const rebuild = engine === 'sqlite' && op === 'alter' && !!spec.alter && sqliteAlterNeedsRebuild(spec.alter);
      let statements: string[];
      if (rebuild) {
        const alter = spec.alter!;
        const info = await driver.describeTable(alter.schema ?? '', alter.table);
        // TableInfo can't reproduce CHECK constraints / generated columns / WITHOUT
        // ROWID — refuse rather than silently drop them in the table rewrite.
        const ddlRow = await driver.runQuery(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, { params: [alter.table] });
        const createSql = String(ddlRow.rows[0]?.sql ?? '');
        if (/\bCHECK\s*\(|\bGENERATED\s+ALWAYS\b|\bWITHOUT\s+ROWID\b/i.test(createSql)) {
          throw new ApiError('db_ddl_unsupported', 422, 'This table uses CHECK constraints, generated columns or WITHOUT ROWID — in-place column/FK changes would drop them. Recreate the table manually.');
        }
        // DROP TABLE drops the table's triggers — capture their DDL to recreate.
        const trg = await driver.runQuery(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`, { params: [alter.table] });
        const triggers = trg.rows.map((r) => String(r.sql)).filter((s) => s && s !== 'null');
        statements = buildSqliteRebuild(info, alter, { triggers });
      } else {
        statements = buildDdl(engine, op, spec);
      }
      const sql = statements.join(';\n') + ';';
      if (dryRun) return { sql };
      // An all-comment set means the engine can't express the change. Surface it
      // instead of silently reporting success after touching nothing.
      if (statements.every((s) => /^\s*--/.test(s))) {
        throw new ApiError('db_ddl_unsupported', 422, statements.join('\n').replace(/^\s*--\s?/gm, '') || 'Unsupported DDL.');
      }
      let result;
      if (rebuild) {
        // The SQLite rebuild list wraps itself in PRAGMA + BEGIN…COMMIT and runs on
        // the single sqlite handle, so apply it statement-by-statement as authored;
        // on a mid-way failure roll back so the connection isn't stranded in an open
        // transaction (and re-enable FKs).
        try {
          for (const stmt of statements) {
            if (/^\s*--/.test(stmt)) continue; // skip comment lines mixed into a larger set
            result = await driver.runQuery(stmt);
          }
        } catch (e) {
          await driver.runQuery('ROLLBACK').catch(() => undefined);
          await driver.runQuery('PRAGMA foreign_keys=ON').catch(() => undefined);
          throw e;
        }
      } else {
        // Multi-statement DDL on one connection in a single transaction: a runQuery
        // loop could hand each statement a different pooled backend (so BEGIN/COMMIT
        // wouldn't share a transaction) and a mid-list failure would leave a partial
        // apply. runBatch pins one connection + rolls back on error (DDL rollback is
        // engine-dependent — MySQL/Oracle implicitly commit DDL).
        const toRun = statements.filter((s) => !/^\s*--/.test(s));
        if (driver.runBatch) {
          result = await driver.runBatch(toRun);
        } else {
          // Fallback for any relational driver without runBatch (none today).
          for (const stmt of toRun) result = await driver.runQuery(stmt);
        }
      }
      return { sql, result };
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
      const effSchema = schema ?? (engine === 'postgres' ? 'public' : undefined);
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
