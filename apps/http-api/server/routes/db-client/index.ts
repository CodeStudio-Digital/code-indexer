import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountDbConnectionRoutes } from './connections.routes.js';
import { mountDbHistoryRoutes } from './history.routes.js';
import { mountDbSavedQueryRoutes } from './saved-queries.routes.js';

/**
 * Embedded database-client routes — saved connections + query history + saved
 * queries CRUD (migration 174). Live database operations (connect, query,
 * introspect, DDL) go through the `dbClient` api-bus namespace (IPC, main
 * process), NOT these HTTP routes.
 */
export function mountDbClientRoutes(app: Hono, deps: ServerDeps): void {
  mountDbConnectionRoutes(app, deps);
  mountDbHistoryRoutes(app, deps);
  mountDbSavedQueryRoutes(app, deps);
}
