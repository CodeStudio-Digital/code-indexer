import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountSshHostRoutes } from './hosts.routes.js';
import { mountSshIdentityRoutes } from './identities.routes.js';
import { mountSshSnippetRoutes } from './snippets.routes.js';

/**
 * Embedded SSH client routes — saved hosts + identities CRUD (migration 173).
 * Live ssh2 operations (connect, shell, SFTP, tunnels) go through the `ssh`
 * api-bus namespace (IPC, main process), NOT these HTTP routes.
 */
export function mountSshRoutes(app: Hono, deps: ServerDeps): void {
  mountSshHostRoutes(app, deps);
  mountSshIdentityRoutes(app, deps);
  mountSshSnippetRoutes(app, deps);
}
