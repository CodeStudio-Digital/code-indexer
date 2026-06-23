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

export type DbSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

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
  /** Abort signal — drivers cancel the in-flight query when it fires. */
  signal?: AbortSignal;
  /**
   * Scope the statement to a schema/database (a console opened on a schema):
   * pg sets `search_path`, MySQL runs `USE`, then resets afterwards — applied on
   * the dedicated per-query connection so it never leaks across queries.
   */
  schema?: string;
}

export interface DatabaseDriver {
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
  /** Paginated `SELECT *` for a table, with engine-correct identifier quoting. */
  tablePreview(schema: string, table: string, opts: { limit: number; offset: number }): Promise<QueryResult>;
  /** Back-compat: all tables in a schema with their columns (agent `db_schema`). */
  schema(schemaName?: string): Promise<TableInfo[]>;
  /** Execute a statement with optional params, row cap, and cancellation. */
  runQuery(sql: string, opts?: RunQueryOptions): Promise<QueryResult>;
  /** Back-compat alias for the agent tools. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

/** Default cap so a `SELECT *` on a huge table never floods the renderer. */
export const DEFAULT_MAX_ROWS = 1000;
