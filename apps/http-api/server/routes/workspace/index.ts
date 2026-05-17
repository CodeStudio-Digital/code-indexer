import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountTreeRoutes } from './tree.routes.js';
import { mountFileRoutes } from './file.routes.js';
import { mountGitRoutes } from './git.routes.js';

/**
 * Workspace routes: read-only filesystem tree, file content, and git
 * status/diff/log (plus opt-in `git init`) scoped to a project linked to
 * a company session. Enables the in-session IDE-lite UI (Files + Git
 * tabs) in BuilderView without granting write access to files.
 */
export function mountWorkspaceRoutes(app: Hono, deps: ServerDeps): void {
  mountTreeRoutes(app, deps);
  mountFileRoutes(app, deps);
  mountGitRoutes(app, deps);
}
