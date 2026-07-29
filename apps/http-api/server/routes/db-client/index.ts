import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { requireTrustedLocalRequest } from '../../middleware/local-origin.js';
import { mountDbConnectionRoutes } from './connections.routes.js';
import { mountDbHistoryRoutes } from './history.routes.js';
import { mountDbSavedQueryRoutes } from './saved-queries.routes.js';

/**
 * Embedded database-client routes — saved connections + query history + saved
 * queries CRUD (migration 174). Live database operations (connect, query,
 * introspect, DDL) go through the `dbClient` api-bus namespace (IPC, main
 * process), NOT these HTTP routes.
 *
 * These rows carry the whole database credential surface: hostnames, ports,
 * usernames, the `enc_password`/`enc_ssl_*` blobs and the query history (which
 * quotes production SQL verbatim). The standalone server can bind off-loopback
 * and CORS reflects any loopback origin, so without a guard any LAN peer — or
 * any page in the user's browser — could enumerate the saved connections and
 * PATCH one to point at attacker infrastructure, harvesting credentials the
 * next time the user clicks Connect. One guard covers all three mounts; it
 * admits the in-process Electron dispatch (`mcp://app` has no socket).
 * Mirrors `mountSshRoutes`.
 */
export function mountDbClientRoutes(app: Hono, deps: ServerDeps): void {
  app.use('/api/projects/:projectId/db-client/*', requireTrustedLocalRequest);
  mountDbConnectionRoutes(app, deps);
  mountDbHistoryRoutes(app, deps);
  mountDbSavedQueryRoutes(app, deps);
}
