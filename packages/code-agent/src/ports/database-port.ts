import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import type { AcquiredDb } from '../tools/db/pool.js';

export interface DatabaseInvocation {
  readonly signal?: AbortSignal;
  assertDispatch(): void;
}
/** Private per-attempt drivers; no shared UI or other-agent pool ownership. */
export interface DatabasePort {
  listConnections(projectId: number): DbConnection[];
  acquire(connection: DbConnection, invocation: DatabaseInvocation): Promise<AcquiredDb>;
  outcomeUnknown(): void;
}
