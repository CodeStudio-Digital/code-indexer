/**
 * Design System Creator routes — sessions + versions + storybook proxy.
 *
 * Mounted from `server.ts` after the company routes (so the company
 * sessions referenced by DS sessions are already wired). Verdaccio
 * admin routes are mounted separately under `/api/admin` because they
 * are operator-only.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountDesignSystemSessionRoutes } from './sessions.js';
import { mountDesignSystemVersionRoutes } from './versions.js';
import { mountDesignSystemRoundRoutes } from './round.js';
import { mountDesignSystemStudioRoutes } from './studio.js';

export function mountDesignSystemRoutes(app: Hono, deps: ServerDeps): void {
  mountDesignSystemSessionRoutes(app, deps);
  mountDesignSystemVersionRoutes(app, deps);
  mountDesignSystemRoundRoutes(app, deps);
  mountDesignSystemStudioRoutes(app, deps);
}
