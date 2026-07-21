/**
 * Type surface for the embedded database-client feature. Re-exports the wire
 * contract (api-bus) and the saved-connection row shape (store) so components
 * import from one place.
 */
export type {
  DbConnection,
  DbEngine,
  DbSslMode,
  CreateDbConnectionInput,
  DbConnectionPatch,
  DbSavedQuery,
  DbQueryHistoryRow,
} from '@mcp/store/db-client-store-types.js';

export type {
  DbConnectSpec,
  DbColumn,
  DbIndex,
  DbForeignKey,
  DbTableRef,
  DbTableInfo,
  DbQueryResult,
  DbQueryBatchResult,
  DbIntrospectResult,
  DbCatalogObject,
  DbCatalogSnapshot,
  DbSchemaSnapshot,
  DbRowChangeKind,
  DbColumnSpec,
  DbCreateTableSpec,
  DbAlterAction,
  DbAlterTableSpec,
  DbDropTableSpec,
  DbDdlOp,
  DbDdlSpec,
  DbEditResult,
  DbRowChangeInput,
  DbBatchEditResult,
  DbMigrationInput,
  DbMigrationResult,
  DbObjectKind,
  DbGenerateKind,
  DbRowBatch,
  DbDumpFrame,
  DbEngineKind,
  DbCommand,
  DbDriverStatus,
  DbDriverInstallFrame,
  DbTableSort,
  DbWhereOp,
  DbWhereCondition,
} from '@mcp/api-bus';

/** A node in the connection tree (lazy-expanded). */
export type DbTreeKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'group'
  | 'index'
  | 'fk'
  | 'trigger'
  | 'function'
  | 'sequence';

/** Folder-node kind for the `group` tree nodes. */
export type DbTreeGroupKind = 'indexes' | 'fks' | 'triggers' | 'functions' | 'sequences';

export interface DbTreeNode {
  /** Stable path id, e.g. `conn:3/db:app/schema:public/table:users`. */
  id: string;
  kind: DbTreeKind;
  label: string;
  /** For `group` nodes — which object kind the folder lists. */
  groupKind?: DbTreeGroupKind;
  /** Bare identifier (table or column name) for autocomplete — distinct from the display label. */
  name?: string;
  /** Owning connection row id. */
  connectionId: number;
  database?: string;
  schema?: string;
  table?: string;
  depth: number;
  /** Children may exist but haven't been fetched. */
  expandable: boolean;
}

export type DbConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** A tab in the center work area (like the editor's file tabs). */
export type WorkTabKind = 'query' | 'data' | 'structure' | 'er' | 'schema-diff' | 'documents' | 'keyvalue';

export interface WorkTab {
  id: string;
  kind: WorkTabKind;
  /** Display title — for data/structure it's the table; for query it's empty (the bar shows "Query N"). */
  title: string;
  connectionId: number;
  /** Live-op routing key — `id` or `id@db` (Postgres multi-database). */
  connKey: string;
  /** Database/catalog the tab targets (Mongo: the db holding the collection). */
  database?: string;
  schema?: string;
  table?: string;
  /** Sequence number for unnamed query tabs. */
  seq?: number;
  /** Initial SQL for a query tab opened from history / a saved query. */
  initialSql?: string;
  dirty?: boolean;
}
