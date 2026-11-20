/**
 * Composite mount for QA-related routes. Each handler lives in its own
 * file (SRP) — this module only wires them.
 */
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../../deps.js';
import { mountQaRunRoutes } from './runs.js';
import { mountQaTestEventRoute } from './test-event.js';
import { mountQaTestPlanRoutes } from './test-plan.js';
import { mountQaArtifactRoutes } from './artifacts.js';
import { mountQaRestoreConfigRoute } from './restore-config.js';
import { mountQaDiagnosticsRoute } from './diagnostics.js';

export function mountQaRoutes(app: HttpRouter, deps: ServerDeps): void {
  mountQaRunRoutes(app, deps);
  mountQaTestEventRoute(app, deps);
  mountQaTestPlanRoutes(app, deps);
  mountQaArtifactRoutes(app, deps);
  mountQaRestoreConfigRoute(app, deps);
  mountQaDiagnosticsRoute(app, deps);
}
