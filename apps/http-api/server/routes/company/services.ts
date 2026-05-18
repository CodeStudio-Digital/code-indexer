/**
 * Multi-service sandbox routes — coordinator that mounts the three
 * sub-modules so the full CRUD surface lives behind a single import:
 *
 *   - {@link mountCompanyServicesListRoute}    `GET /:id/services`
 *   - {@link mountCompanyServicesCreateRoutes} `POST /:id/services`,
 *                                               `POST /:id/services/attach`
 *   - {@link mountCompanyServicesRuntimeRoutes} `POST /:id/services/:sid/start`,
 *                                               `…/refresh`, `…/retry`,
 *                                               `DELETE /:id/services/:sid`
 *
 * The pause/unpause/logs/restart-dev surface for a single service
 * container lives in `service-lifecycle.ts` (lower-level routes wired
 * directly from `index.ts`).
 *
 * Phase 8 part 2 (continuation): extracted from the 2346-LOC
 * `sessions.ts` mega-file. Each sub-module stays under the 500-LOC cap.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountCompanyServicesListRoute } from './services-list.js';
import { mountCompanyServicesCreateRoutes } from './services-create.js';
import { mountCompanyServicesRuntimeRoutes } from './services-runtime.js';

export function mountCompanyServicesRoutes(app: Hono, deps: ServerDeps): void {
  mountCompanyServicesListRoute(app, deps);
  mountCompanyServicesCreateRoutes(app, deps);
  mountCompanyServicesRuntimeRoutes(app, deps);
}
