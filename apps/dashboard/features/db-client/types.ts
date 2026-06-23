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
} from '@mcp/api-bus';

/** A node in the connection tree (lazy-expanded). */
export type DbTreeKind = 'database' | 'schema' | 'table' | 'view' | 'column';

export interface DbTreeNode {
  /** Stable path id, e.g. `conn:3/db:app/schema:public/table:users`. */
  id: string;
  kind: DbTreeKind;
  label: string;
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
