/**
 * `/api/config/features` — exposes runtime feature flags to the dashboard.
 *
 * The dashboard runs in the browser (no `process.env`), so any toggle that
 * the user expects to control via env vars on the server has to be fetched
 * over the wire.
 */
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../deps.js';

export function mountConfigRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.get('/api/config/features', (c) => {
    return c.json(deps.config.features);
  });
}
