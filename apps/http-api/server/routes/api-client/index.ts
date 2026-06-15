import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountApiCollectionRoutes } from './collections.routes.js';
import { mountApiEnvironmentRoutes } from './environments.routes.js';
import { mountApiSendRoute } from './send.routes.js';
import { mountApiRegressionRoutes } from './regression.routes.js';

/**
 * API client (in-app Postman) routes — collections/requests/environments CRUD,
 * the CORS-free "send" proxy, OpenAPI import + the non-LLM regression runner.
 */
export function mountApiClientRoutes(app: Hono, deps: ServerDeps): void {
  mountApiCollectionRoutes(app, deps);
  mountApiEnvironmentRoutes(app, deps);
  mountApiSendRoute(app, deps);
  mountApiRegressionRoutes(app, deps);
}
