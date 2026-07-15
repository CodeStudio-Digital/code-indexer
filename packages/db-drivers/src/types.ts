/**
 * Shared driver vocabulary for the embedded database client (@mcp/db-drivers).
 *
 * One implementation, two consumers: the `dbClient` api-bus handlers (UI) and
 * the `db_*` agent tools (via the company shim). Engine-specific SQL lives
 * behind the `DatabaseDriver` interface — adding an engine = one new impl + one
 * case in the factory; callers stay untouched.
 */

export type DbEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'mssql'
  | 'mongodb'
  | 'redis'
  | 'oracle';

/**
 * Engine category. Relational engines (pg/mysql/sqlite/mssql/oracle) speak the
 * full SQL/table/column surface; document (Mongo) and key-value (Redis) stores
 * don't — they go through `runCommand` and skip the relational methods.
 */
export type DbEngineKind = 'relational' | 'document' | 'keyvalue';

export type DbSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

/** Object kinds listed lazily in the tree (beyond tables/views/columns). */
export type DbObjectKind = 'triggers' | 'functions' | 'sequences';

export interface DbSslConfig {
  mode?: DbSslMode;
  ca?: string;
  cert?: string;
  key?: string;
}

/**
 * Structured connect config. The renderer decrypts secrets and builds this
 * just-in-time; it is consumed into a pool and dropped. `connectionString` is
 * the back-compat path for the agent tools (which historically pass a URL).
 */
export interface DbConnectConfig {
  engine: DbEngine;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** sqlite only — path to the .sqlite/.db file. */
  filePath?: string;
  ssl?: DbSslConfig;
  options?: Record<string, unknown>;
  /** Back-compat: a full connection URL. When set it wins over the fields above. */
  connectionString?: string;
  /**
   * Defense-in-depth read-only mode. The factory rejects mutating SQL/commands
   * before they reach a driver; engines with a native/session read-only mode
   * also enable it. This never grants permissions the database user lacks.
   */
  readOnly?: boolean;
}

export interface QueryField {
  name: string;
  dataTypeId?: number;
}

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  fields: QueryField[];
  /** Non-SELECT statement verb when known (e.g. 'INSERT', 'UPDATE'). */
  command?: string;
  /** True when rows were capped by `maxRows`. */
  truncated?: boolean;
  /** Redis SCAN continuation cursor ('0' = end). Set by the keyvalue driver. */
  cursor?: string;
}

/** Column sort for a table preview (column name is quoted by the driver). */
export interface TableSort {
  column: string;
  dir: 'asc' | 'desc';
}

/** WHERE comparison operator — a closed enum (no injection via operator). */
export type WhereOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'like' | 'isnull' | 'isnotnull';

/** A single WHERE condition for the visual filter (AND-combined, parameterized). */
export interface WhereCondition {
  column: string;
  op: WhereOp;
  /** Bound value (ignored for isnull/isnotnull). */
  value?: string;
}

export interface ColumnInfo {
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
  /** Enumerated values when the engine exposes them through metadata. */
  enumValues?: string[];
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary?: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind?: 'table' | 'view';
  columns: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
  approxRowCount?: number;
}

/** Light tree node for lazy introspection. */
export interface TableRef {
  schema: string;
  name: string;
  kind: 'table' | 'view';
}

export interface RunQueryOptions {
  params?: unknown[];
  /** Hard cap on rows returned to the client. Excess rows set `truncated`. */
  maxRows?: number;
  /** Per-statement execution deadline in milliseconds. */
  timeoutMs?: number;
  /** Abort signal — drivers cancel the in-flight query when it fires. */
  signal?: AbortSignal;
  /**
   * Scope the statement to a schema/database (a console opened on a schema):
   * pg sets `search_path`, MySQL runs `USE`, then resets afterwards — applied on
   * the dedicated per-query connection so it never leaks across queries.
   */
  schema?: string;
}

export interface RunBatchOptions {
  /** Abort signal — the driver cancels the in-flight batch when it fires. */
  signal?: AbortSignal;
  /** Hard cap on rows for any statement in the batch that returns rows. */
  maxRows?: number;
}

/**
 * A non-relational command (Mongo document op / Redis command). The shape is
 * engine-specific; the relevant driver narrows it. Carried generically here so
 * the contract + manager stay engine-agnostic.
 */
export interface DbCommand {
  /** Engine category this command targets (matches the driver's `kind`). */
  kind: Exclude<DbEngineKind, 'relational'>;
  /** Mongo: the operation (find/aggregate/insertOne/updateMany/…). */
  op?: string;
  /** Mongo: the target collection. */
  collection?: string;
  /** Redis: the command + args, e.g. `['GET','key']`. */
  args?: string[];
  /** Operation-specific payload (filter/pipeline/document/value/…). */
  payload?: unknown;
}

export interface DatabaseDriver {
  /** Engine category — drives capability gating in the handler/UI. Undefined ⇒ relational. */
  readonly kind?: DbEngineKind;
  /** Open + ping; returns the server version. Throws on failure. */
  testConnection(): Promise<{ serverVersion?: string }>;
  /** Top-level databases/catalogs reachable on this connection. */
  listDatabases(): Promise<string[]>;
  /** Schemas within a database (for engines without schemas, returns the database). */
  listSchemas(database?: string): Promise<string[]>;
  /** Tables + views within a schema (lazy tree expansion). */
  listTables(schema?: string): Promise<TableRef[]>;
  /** Deep single-table introspection: columns + indexes + foreign keys. */
  describeTable(schema: string, name: string): Promise<TableInfo>;
  /** Names of schema/table objects of a kind (triggers/functions/sequences) for the tree. */
  listObjects(kind: DbObjectKind, schema?: string, table?: string): Promise<string[]>;
  /** Paginated `SELECT *` for a table, with engine-correct quoting + optional sort + WHERE filter. */
  tablePreview(schema: string, table: string, opts: { limit: number; offset: number; orderBy?: TableSort; where?: WhereCondition[] }): Promise<QueryResult>;
  /** Back-compat: all tables in a schema with their columns (agent `db_schema`). */
  schema(schemaName?: string): Promise<TableInfo[]>;
  /** Execute a statement with optional params, row cap, and cancellation. */
  runQuery(sql: string, opts?: RunQueryOptions): Promise<QueryResult>;
  /**
   * Execute a list of statements on a SINGLE pinned connection wrapped in one
   * transaction (BEGIN…/COMMIT, ROLLBACK on any failure), returning the LAST
   * statement's result. Relational engines only — document/key-value stores omit
   * it. Use this (not a `runQuery` loop) whenever statements must share a
   * connection and/or be applied atomically: a `runQuery` loop can hop pooled
   * connections between statements, so manual BEGIN/COMMIT issued as separate
   * statements aren't guaranteed to land on the same backend.
   *
   * Engine caveat: MySQL/MariaDB and Oracle implicitly COMMIT on DDL, so a
   * mid-batch failure after a DDL statement can't be rolled back — runBatch still
   * pins every statement to one connection (no pool hop), but the transactional
   * rollback only covers DML there. Postgres, SQL Server and SQLite roll back DDL.
   */
  runBatch?(statements: string[], opts?: RunBatchOptions): Promise<QueryResult>;
  /** Back-compat alias for the agent tools. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Non-relational entry point (document/key-value). Rows hold documents / KV pairs. */
  runCommand?(command: DbCommand, opts?: RunQueryOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

/** Default cap so a `SELECT *` on a huge table never floods the renderer. */
export const DEFAULT_MAX_ROWS = 1000;
