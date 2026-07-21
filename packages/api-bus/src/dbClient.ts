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

import type { ApiContext, AsyncStream } from './common.js';
import type { SshConnectSpec } from './ssh.js';

export type DbEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'mssql'
  | 'mongodb'
  | 'redis'
  | 'oracle';

/** Engine category — relational (SQL/tables) vs document (Mongo) vs key-value (Redis). */
export type DbEngineKind = 'relational' | 'document' | 'keyvalue';

/** Column sort for a table preview. */
export interface DbTableSort {
  column: string;
  dir: 'asc' | 'desc';
}

/** WHERE comparison operator for the visual filter — a closed enum. */
export type DbWhereOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'like' | 'isnull' | 'isnotnull';

/** A single WHERE condition (AND-combined, value bound as a parameter). */
export interface DbWhereCondition {
  column: string;
  op: DbWhereOp;
  value?: string;
}

/** A non-relational command (Mongo document op / Redis command). Engine-specific shape. */
export interface DbCommand {
  kind: Exclude<DbEngineKind, 'relational'>;
  op?: string;
  collection?: string;
  args?: string[];
  payload?: unknown;
}

/** Install status for an on-demand (lazily-downloaded) driver. */
export interface DbDriverStatus {
  engine: DbEngine;
  package: string;
  version: string;
  installed: boolean;
  sizeLabel: string;
  pureJs: boolean;
}

/** Progress frame while a driver downloads/installs. */
export type DbDriverInstallFrame =
  | { phase: 'start'; engine: DbEngine; version: string; targetDir: string }
  | { phase: 'log'; line: string }
  | { phase: 'done'; installDir: string }
  | { phase: 'error'; message: string };

export type DbSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

/** Lazily-listed schema objects beyond tables/views/columns. */
export type DbObjectKind = 'triggers' | 'functions' | 'sequences';
/** What `generateSql` produces for a table. */
export type DbGenerateKind = 'create' | 'select' | 'insert' | 'truncate';

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
  /** URL mode — a full connection string (decrypted just-in-time); wins over fields. */
  connectionString?: string;
  ssl?: { mode?: DbSslMode; ca?: string; cert?: string; key?: string };
  options?: Record<string, unknown>;
  /** App + driver safety valve — mutating statements/commands are rejected. */
  readOnly?: boolean;
  /** Optional local SSH forward opened and owned by this DB connection. */
  sshTunnel?: {
    spec: SshConnectSpec;
    remoteHost: string;
    remotePort: number;
  };
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
  /** Enumerated values when the driver can introspect them (for example PostgreSQL ENUM). */
  enumValues?: string[];
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

/** A foreign key owned by another table that points at the requested table. */
export interface DbIncomingForeignKey {
  schema: string;
  table: string;
  foreignKey: DbForeignKey;
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
  /** Redis SCAN continuation cursor ('0' = end). */
  cursor?: string;
  /** Wall-clock execution time in ms (filled by the handler). */
  durationMs?: number;
}

export interface DbIntrospectResult {
  schemas: string[];
  tables: DbTableRef[];
}

export interface DbCatalogObject {
  kind: 'schema' | 'table' | 'view' | 'function' | 'sequence';
  name: string;
  schema?: string;
}

export interface DbCatalogSnapshot {
  objects: DbCatalogObject[];
  refreshedAt: number;
}

export interface DbSchemaSnapshot {
  schema: string;
  tables: DbTableInfo[];
  capturedAt: number;
}

// ─── DDL / DML edit specs (mirror @mcp/db-drivers, kept self-contained here) ──
export type DbRowChangeKind = 'insert' | 'update' | 'delete';

export interface DbColumnSpec {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string | null;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unsigned?: boolean;
}
export interface DbCreateTableSpec {
  schema?: string;
  table: string;
  columns: DbColumnSpec[];
}
export interface DbIndexSpec {
  name: string;
  columns: string[];
  unique?: boolean;
}
export interface DbForeignKeySpec {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}
export type DbAlterAction =
  | { kind: 'addColumn'; column: DbColumnSpec }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'modifyColumn'; name: string; column: DbColumnSpec }
  | { kind: 'renameTable'; to: string }
  | { kind: 'addIndex'; index: DbIndexSpec }
  | { kind: 'dropIndex'; name: string }
  | { kind: 'addForeignKey'; fk: DbForeignKeySpec }
  | { kind: 'dropForeignKey'; name: string };
export interface DbAlterTableSpec {
  schema?: string;
  table: string;
  actions: DbAlterAction[];
}
export interface DbDropTableSpec {
  schema?: string;
  table: string;
}
export type DbDdlOp = 'create' | 'alter' | 'drop';
export interface DbDdlSpec {
  create?: DbCreateTableSpec;
  alter?: DbAlterTableSpec;
  drop?: DbDropTableSpec;
}

/** Result of an edit/DDL op: the rendered SQL (for the preview) + execution result. */
export interface DbEditResult {
  /** Human-readable SQL with literals inlined — for the preview dialog. */
  sql: string;
  /** Present when actually executed (omitted on dryRun). */
  result?: DbQueryResult;
}

/** Results from an atomic, single-session statement batch. */
export interface DbQueryBatchResult {
  results: DbQueryResult[];
  durationMs: number;
}

/** Parameterized row mutation used by the atomic multi-row editor endpoint. */
export interface DbRowChangeInput {
  op: DbRowChangeKind;
  schema?: string;
  table: string;
  pk?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

/** A whole grid changeset, previewed and committed as one unit. */
export interface DbBatchEditResult extends DbEditResult {
  applied: number;
  results?: DbQueryResult[];
}

/** One ordered DDL operation in a generated schema migration. */
export interface DbMigrationInput {
  op: DbDdlOp;
  spec: DbDdlSpec;
}

/** Preview/apply result for a selected schema migration. */
export interface DbMigrationResult extends DbEditResult {
  applied: number;
  /** True when the engine can roll the complete migration back on failure. */
  atomic: boolean;
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
  ): Promise<{ sessionToken: string; serverVersion?: string; kind?: DbEngineKind }>;

  /** Drop the pool for a connection (called on tab close / project switch). */
  disconnect(input: { connectionId: string }, ctx: ApiContext): Promise<void>;

  /** Top-level databases/catalogs reachable on the connection (tree root). */
  listDatabases(input: { connectionId: string }, ctx: ApiContext): Promise<string[]>;

  /** Lazy tree expansion: schemas + tables for a database. */
  introspect(
    input: { connectionId: string; database?: string; schema?: string },
    ctx: ApiContext,
  ): Promise<DbIntrospectResult>;

  /** Build/read a connection-wide names catalog, independent of expanded tree nodes. */
  catalog(
    input: { connectionId: string; force?: boolean },
    ctx: ApiContext,
  ): Promise<DbCatalogSnapshot>;

  /** Search the complete cached catalog (refreshing it when stale/missing). */
  searchCatalog(
    input: { connectionId: string; query: string; limit?: number },
    ctx: ApiContext,
  ): Promise<DbCatalogObject[]>;

  /** Capture a detailed schema state for comparison/migration generation. */
  schemaSnapshot(
    input: { connectionId: string; schema: string },
    ctx: ApiContext,
  ): Promise<DbSchemaSnapshot>;

  /** Deep single-table introspection for the column editor. */
  describeTable(
    input: { connectionId: string; schema: string; table: string },
    ctx: ApiContext,
  ): Promise<DbTableInfo>;

  /** Targeted reverse-FK lookup used by related-row navigation. */
  incomingForeignKeys(
    input: { connectionId: string; schema: string; table: string },
    ctx: ApiContext,
  ): Promise<DbIncomingForeignKey[]>;

  /** Paginated `SELECT *` for a table (double-click → data tab), with optional column sort + WHERE filter. */
  tableRows(
    input: { connectionId: string; schema: string; table: string; limit: number; offset: number; orderBy?: DbTableSort; where?: DbWhereCondition[] },
    ctx: ApiContext,
  ): Promise<DbQueryResult>;

  /** Names of schema/table objects of a kind (tree groups: triggers/functions/sequences). */
  listObjects(
    input: { connectionId: string; kind: DbObjectKind; schema?: string; table?: string },
    ctx: ApiContext,
  ): Promise<string[]>;

  /** Generate SQL for a table: full CREATE (Show DDL), a SELECT or an INSERT template. */
  generateSql(
    input: { connectionId: string; schema?: string; table: string; kind: DbGenerateKind },
    ctx: ApiContext,
  ): Promise<{ sql: string }>;

  /** Execute a statement (server caps rows). Pass `queryId` to allow cancel. */
  query(
    input: {
      connectionId: string;
      sql: string;
      params?: unknown[];
      maxRows?: number;
      /** Per-statement execution deadline in milliseconds. */
      timeoutMs?: number;
      queryId?: string;
      /** Scope this console to a schema (pg search_path / mysql USE). */
      schema?: string;
    },
    ctx: ApiContext,
  ): Promise<DbQueryResult>;

  /** Execute statements on one pinned connection and commit them atomically. */
  queryBatch(
    input: {
      connectionId: string;
      statements: Array<{ sql: string; params?: unknown[] }>;
      maxRows?: number;
      timeoutMs?: number;
      queryId?: string;
      schema?: string;
    },
    ctx: ApiContext,
  ): Promise<DbQueryBatchResult>;

  /** Abort an in-flight query by its client-supplied queryId. */
  cancel(input: { connectionId: string; queryId: string }, ctx: ApiContext): Promise<void>;

  /** Run the engine's EXPLAIN for a statement (does not execute it) → plan rows. */
  explain(input: { connectionId: string; sql: string }, ctx: ApiContext): Promise<DbQueryResult>;

  /**
   * Apply a single row change (insert/update/delete), parameterized + PK-scoped.
   * `dryRun` returns the rendered SQL WITHOUT executing (for the preview dialog).
   */
  editRow(
    input: {
      connectionId: string;
      op: DbRowChangeKind;
      schema?: string;
      table: string;
      pk?: Record<string, unknown>;
      values?: Record<string, unknown>;
      dryRun?: boolean;
    },
    ctx: ApiContext,
  ): Promise<DbEditResult>;

  /** Preview or atomically apply a parameterized row changeset on one pinned connection. */
  editRows(
    input: { connectionId: string; changes: DbRowChangeInput[]; dryRun?: boolean },
    ctx: ApiContext,
  ): Promise<DbBatchEditResult>;

  /**
   * Run a DDL change (create/alter/drop table). `dryRun` returns the rendered
   * SQL preview WITHOUT executing. Rejected when the connection is read-only.
   */
  ddl(
    input: { connectionId: string; op: DbDdlOp; spec: DbDdlSpec; dryRun?: boolean },
    ctx: ApiContext,
  ): Promise<DbEditResult>;

  /** Preview or apply an ordered set of generated DDL changes. */
  migration(
    input: { connectionId: string; changes: DbMigrationInput[]; dryRun?: boolean },
    ctx: ApiContext,
  ): Promise<DbMigrationResult>;

  /**
   * Stream a whole table out in row batches (server-paged, so neither the DB
   * driver nor the renderer ever holds the full table at once). The client
   * formats each batch (CSV / SQL INSERTs) and writes incrementally. Unbounded —
   * unlike the row-capped `query`/`tableRows`.
   */
  exportStream(
    input: { connectionId: string; schema?: string; table: string; batchRows?: number },
    ctx: ApiContext,
  ): AsyncStream<DbRowBatch>;

  /**
   * Stream a `.sql` dump (CREATE + INSERT literals) for a whole schema or a
   * selected table list. Server-paged so a huge table never lands in memory; the
   * client appends each `sql` chunk to a file. Relational connections only.
   */
  dumpStream(
    input: { connectionId: string; schema?: string; tables?: string[]; includeData?: boolean; batchRows?: number },
    ctx: ApiContext,
  ): AsyncStream<DbDumpFrame>;

  /**
   * Run a list of statements (a restore/import script) on one pinned connection,
   * transactional where the engine allows DDL rollback. Relational only; blocked
   * on a read-only connection. Returns the last statement's result.
   */
  runScript(
    input: { connectionId: string; statements: string[] },
    ctx: ApiContext,
  ): Promise<DbQueryResult>;

  /**
   * Run a non-relational command (document/key-value). Rejected for relational
   * connections (use `query`) and, on a read-only connection, for write commands.
   */
  runCommand(
    input: { connectionId: string; command: DbCommand; maxRows?: number },
    ctx: ApiContext,
  ): Promise<DbQueryResult>;

  /** Install status of the lazily-downloaded drivers (Oracle/Mongo/Redis). */
  driverStatus(input: Record<string, never>, ctx: ApiContext): Promise<DbDriverStatus[]>;

  /** Download + install an on-demand driver, streaming progress. */
  installDriverStream(input: { engine: DbEngine }, ctx: ApiContext): AsyncStream<DbDriverInstallFrame>;
}

export interface DbRowBatch {
  /** Column names (stable across batches; sent on every frame for convenience). */
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Running total of rows emitted so far. */
  total: number;
  /** True on the final frame (no more rows). */
  done: boolean;
}

export interface DbDumpFrame {
  /** A chunk of `.sql` text to append to the output file (may be empty on the final frame). */
  sql: string;
  /** The table this chunk belongs to (absent for the header frame). */
  table?: string;
  /** Running total of data rows dumped so far. */
  total: number;
  /** True on the final frame. */
  done: boolean;
}
