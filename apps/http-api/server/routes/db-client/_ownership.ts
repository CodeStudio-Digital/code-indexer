import type { DbClientStore } from '@mcp/store/db-client-store.js';
import type { DbConnection, DbSavedQuery } from '@mcp/store/db-client-store-types.js';

/**
 * Cross-project ownership guards for the database-client routes.
 *
 * Connections/saved-queries are looked up by their OWN row id (ids are NOT
 * project-scoped), so after an in-place project switch the client could hold a
 * stale id from a different project. Without these guards a stale id would let
 * one project read or mutate another project's saved connection — including its
 * device-bound encrypted credentials. Every `:cid`/`:sqid` handler must resolve
 * ownership here and treat a mismatch as "not found". Mirrors the SSH
 * `_ownership.ts` model.
 */

export function connectionInProject(
  store: DbClientStore,
  projectId: number,
  cid: number,
): DbConnection | null {
  const c = store.getConnection(cid);
  return c && c.project_id === projectId ? c : null;
}

export function savedQueryInProject(
  store: DbClientStore,
  projectId: number,
  sqid: number,
): DbSavedQuery | null {
  const q = store.getSavedQuery(sqid);
  return q && q.project_id === projectId ? q : null;
}
