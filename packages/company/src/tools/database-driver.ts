/**
 * Driver abstraction for the `db_*` agent tools.
 *
 * This is now a thin shim over the shared `@mcp/db-drivers` package — the SAME
 * implementation the embedded database-client UI uses, so connection pooling,
 * introspection and dialect handling live in exactly one place. The agent keeps
 * its original `getDriver(...)` signature and the pool cache keyed by
 * (sessionId, dbId, url); a URL change invalidates the stale pool so env
 * rotations take effect on the next query.
 */

import {
  sharedDbConnectionManager,
  createDriver as createDriverDirect,
  type DatabaseDriver,
  type QueryField,
  type QueryResult,
  type ColumnInfo,
  type TableInfo,
} from '@mcp/db-drivers';
import type { DatabaseWireProtocol } from '@mcp/company/database-types.js';

export type { DatabaseDriver, QueryField, QueryResult, ColumnInfo, TableInfo };

/**
 * Look up (or create) a driver for the given session+db. Entries are tagged by
 * (sessionId, dbId, url) — a URL change for the same (sessionId, dbId)
 * invalidates the cached pool so env rotations take effect on next query.
 */
export function getDriver(
  sessionId: number,
  dbId: number,
  wireProtocol: DatabaseWireProtocol,
  connectionUrl: string,
): Promise<DatabaseDriver> {
  const key = `${sessionId}:${dbId}:${connectionUrl}`;
  const invalidatePrefix = `${sessionId}:${dbId}:`;
  return sharedDbConnectionManager().acquire(
    key,
    { engine: wireProtocol, connectionString: connectionUrl },
    { invalidatePrefix },
  );
}

/** Close all pooled drivers. For tests and graceful shutdown. */
export function closeAllDrivers(): Promise<void> {
  return sharedDbConnectionManager().closeAll();
}

/** Build a one-off driver (no pooling) from a wire protocol + URL. */
export function createDriver(
  wireProtocol: DatabaseWireProtocol,
  connectionUrl: string,
): Promise<DatabaseDriver> {
  return createDriverDirect({ engine: wireProtocol, connectionString: connectionUrl });
}
