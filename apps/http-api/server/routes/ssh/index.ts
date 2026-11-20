import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { requireTrustedLocalRequest } from '../../middleware/local-origin.js';
import { mountSshHostRoutes } from './hosts.routes.js';
import { mountSshIdentityRoutes } from './identities.routes.js';
import { mountSshSnippetRoutes } from './snippets.routes.js';
import { mountSshSecretRoutes } from './secrets.routes.js';

/**
 * Embedded SSH client routes — saved hosts + identities CRUD (migration 173),
 * plus snippets and named `${secret:…}` values (migration 197). Live ssh2
 * operations (connect, shell, SFTP, tunnels) go through the `ssh` api-bus
 * namespace (IPC, main process), NOT these HTTP routes.
 *
 * These rows carry the whole SSH attack surface: hostnames, usernames, ports,
 * and the `enc_*` credential blobs. Global CORS is `*` and the standalone
 * server can bind off-loopback, so ONE guard goes in front of all four
 * mounts — otherwise any LAN peer (or any web page in the user's browser)
 * could read the fleet and PATCH a saved host to point at attacker
 * infrastructure. The guard admits the in-process Electron dispatch; see
 * `requireTrustedLocalRequest`.
 */
export function mountSshRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.use('/api/projects/:projectId/ssh/*', requireTrustedLocalRequest);
  mountSshHostRoutes(app, deps);
  mountSshIdentityRoutes(app, deps);
  mountSshSnippetRoutes(app, deps);
  mountSshSecretRoutes(app, deps);
}
