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
  DbIntrospectResult,
  DbRowChangeKind,
  DbColumnSpec,
  DbCreateTableSpec,
  DbAlterAction,
  DbAlterTableSpec,
  DbDropTableSpec,
  DbDdlOp,
  DbDdlSpec,
  DbEditResult,
} from '@mcp/api-bus';

/** A node in the connection tree (lazy-expanded). */
export type DbTreeKind = 'database' | 'schema' | 'table' | 'view' | 'column';

export interface DbTreeNode {
  /** Stable path id, e.g. `conn:3/db:app/schema:public/table:users`. */
  id: string;
  kind: DbTreeKind;
  label: string;
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
export type WorkTabKind = 'query' | 'data' | 'structure';

export interface WorkTab {
  id: string;
  kind: WorkTabKind;
  /** Display title — for data/structure it's the table; for query it's empty (the bar shows "Query N"). */
  title: string;
  connectionId: number;
  schema?: string;
  table?: string;
  /** Sequence number for unnamed query tabs. */
  seq?: number;
  dirty?: boolean;
}
