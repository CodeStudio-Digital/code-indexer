/**
 * Embedded database client (DataGrip × phpMyAdmin) — the `dbClient` namespace.
 *
 * The LIVE plane: connection pools, query execution + cancel, introspection,
 * and (later) DDL. Runs in the Electron main process next to the SSH connection
 * manager; pools live in the shared `@mcp/db-drivers` `DbConnectionManager`.
 *
 * Saved-connection METADATA (with device-bound `enc_*` secrets) is a separate
 * concern handled by the Hono CRUD routes at /api/projects/:id/db-client/* — the
 * server never sees plaintext. The renderer decrypts a saved secret via the
 * `secrets:*` IPC and builds a `DbConnectSpec` carrying the plaintext password,
 * which crosses ONLY the in-process IPC channel into the pool, then is dropped.
 * Later ops pass only `connectionId`.
 *
 * Types here are intentionally self-contained (no import of `@mcp/db-drivers`)
 * so the renderer bundle never pulls the native driver implementation.
 */

import type { ApiContext } from './common.js';

export type DbEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'mssql'
  | 'mongodb'
  | 'redis'
  | 'oracle';

export type DbSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

/**
 * Everything needed to open a live connection. For a SAVED connection the
 * renderer resolves this from the DbClientStore row, decrypting `enc_password`
 * via the `secrets` shim; for the editor's "Test/Connect" button it's built
 * straight from the form with a `draft:<uuid>` connectionId. The plaintext
 * password lives only transiently and only crosses the in-process IPC channel.
 */
export interface DbConnectSpec {
  /** Saved row id (as string) or `draft:<uuid>` for an unsaved editor connection. */
  connectionId: string;
  engine: DbEngine;
  host?: string;
  port?: number;
  username?: string;
  /** Plaintext — decrypted just-in-time by the renderer; never persisted. */
  password?: string;
  database?: string;
  /** sqlite only. */
  filePath?: string;
  ssl?: { mode?: DbSslMode; ca?: string; cert?: string; key?: string };
  options?: Record<string, unknown>;
  /** Server-enforced safety valve — when true, non-SELECT statements are rejected. */
  readOnly?: boolean;
}

export interface DbColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement?: boolean;
  defaultValue?: string | null;
  ordinal?: number;
  charMaxLength?: number | null;
  numericPrecision?: number | null;
  comment?: string | null;
}

export interface DbIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary?: boolean;
}

export interface DbForeignKey {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface DbTableRef {
  schema: string;
  name: string;
  kind: 'table' | 'view';
}

export interface DbTableInfo {
  schema: string;
  name: string;
  kind?: 'table' | 'view';
  columns: DbColumn[];
  indexes?: DbIndex[];
  foreignKeys?: DbForeignKey[];
  approxRowCount?: number;
}

export interface DbQueryField {
  name: string;
  dataTypeId?: number;
}

export interface DbQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  fields: DbQueryField[];
  command?: string;
  truncated?: boolean;
  /** Wall-clock execution time in ms (filled by the handler). */
  durationMs?: number;
}

export interface DbIntrospectResult {
  schemas: string[];
  tables: DbTableRef[];
}

export interface DbClientApi {
  /** Open + ping + close — a pre-flight for the editor; never keeps a pool. */
  testConnection(
    input: { spec: DbConnectSpec },
    ctx: ApiContext,
  ): Promise<{ ok: true; serverVersion?: string } | { ok: false; reason: string }>;

  /** Establish (or replace) a pinned pool keyed by connectionId. */
  connect(
    input: { spec: DbConnectSpec },
    ctx: ApiContext,
  ): Promise<{ sessionToken: string; serverVersion?: string }>;

  /** Drop the pool for a connection (called on tab close / project switch). */
  disconnect(input: { connectionId: string }, ctx: ApiContext): Promise<void>;

  /** Top-level databases/catalogs reachable on the connection (tree root). */
  listDatabases(input: { connectionId: string }, ctx: ApiContext): Promise<string[]>;

  /** Lazy tree expansion: schemas + tables for a database. */
  introspect(
    input: { connectionId: string; database?: string; schema?: string },
    ctx: ApiContext,
  ): Promise<DbIntrospectResult>;

  /** Deep single-table introspection for the column editor. */
  describeTable(
    input: { connectionId: string; schema: string; table: string },
    ctx: ApiContext,
  ): Promise<DbTableInfo>;

  /** Execute a statement (server caps rows). Pass `queryId` to allow cancel. */
  query(
    input: {
      connectionId: string;
      sql: string;
      params?: unknown[];
      maxRows?: number;
      queryId?: string;
    },
    ctx: ApiContext,
  ): Promise<DbQueryResult>;

  /** Abort an in-flight query by its client-supplied queryId. */
  cancel(input: { connectionId: string; queryId: string }, ctx: ApiContext): Promise<void>;
}
