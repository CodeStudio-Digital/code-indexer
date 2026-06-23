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
import { createDriver, sharedDbConnectionManager, type DbConnectConfig } from '@mcp/db-drivers';
import type { HandlerDeps } from '../types.js';

/** Pool key for a UI connection — distinct keyspace from the agent pools. */
function keyFor(connectionId: string): string {
  return `conn:${connectionId}`;
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
    ssl: spec.ssl,
    options: spec.options,
  };
}

/** Leading-keyword check: is this statement a read (safe under read-only)? */
const READ_PREFIX = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(select|with|show|explain|describe|desc|pragma|table)\b/i;
function isReadStatement(sql: string): boolean {
  return READ_PREFIX.test(sql);
}

export function createDbClientHandlers(_deps: HandlerDeps): DbClientApi {
  const mgr = sharedDbConnectionManager();
  const readOnlyByConn = new Map<string, boolean>();
  /** In-flight query cancellation, keyed by `${connectionId}:${queryId}`. */
  const inflight = new Map<string, AbortController>();

  function requireDriver(connectionId: string) {
    const driver = mgr.get(keyFor(connectionId));
    if (!driver) throw new ApiError('db_not_connected', 409, `Not connected: ${connectionId}`);
    return driver;
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
      readOnlyByConn.set(spec.connectionId, !!spec.readOnly);
      let serverVersion: string | undefined;
      try {
        serverVersion = (await driver.testConnection()).serverVersion;
      } catch (err) {
        // Connect failed at ping — tear the pool down so we don't leak it.
        await mgr.closeKey(key);
        readOnlyByConn.delete(spec.connectionId);
        throw new ApiError('db_connect_failed', 502, err instanceof Error ? err.message : String(err));
      }
      return { sessionToken: `dbsess:${spec.connectionId}`, serverVersion };
    },

    async disconnect({ connectionId }) {
      readOnlyByConn.delete(connectionId);
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

    async query({ connectionId, sql, params, maxRows, queryId }) {
      const driver = requireDriver(connectionId);
      if (readOnlyByConn.get(connectionId) && !isReadStatement(sql)) {
        throw new ApiError('db_read_only', 403, 'Connection is read-only — only SELECT statements are allowed.');
      }
      const controller = new AbortController();
      const inflightKey = queryId ? `${connectionId}:${queryId}` : null;
      if (inflightKey) inflight.set(inflightKey, controller);
      const started = Date.now();
      try {
        const result = await driver.runQuery(sql, { params, maxRows, signal: controller.signal });
        return { ...result, durationMs: Date.now() - started };
      } finally {
        if (inflightKey) inflight.delete(inflightKey);
      }
    },

    async cancel({ connectionId, queryId }) {
      inflight.get(`${connectionId}:${queryId}`)?.abort();
    },
  };
}
