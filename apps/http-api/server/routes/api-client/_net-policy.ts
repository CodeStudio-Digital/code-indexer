import type { ServerDeps } from '../../deps.js';

/**
 * SSRF / file-exfil policy for the api-client send proxy.
 *
 * `blockPrivateHosts` is OFF by default: the proxy's primary use is testing a
 * LOCAL dev server (localhost / RFC1918), so blocking those by default would
 * break the feature. Operators who expose the app on a LAN or run it in a
 * multi-tenant / cloud deployment should set MCP_API_CLIENT_BLOCK_PRIVATE_HOSTS=1
 * — then the proxy refuses internal/loopback/metadata destinations AND contains
 * file-backed bodies to the project root (so it can't be used as an SSRF relay
 * or an arbitrary-file-read-then-POST exfil primitive).
 */
export function blockPrivateHosts(): boolean {
  return process.env.MCP_API_CLIENT_BLOCK_PRIVATE_HOSTS === '1';
}

/** On-disk project root, used to contain file-backed request bodies. */
export function projectRoot(deps: ServerDeps, projectId: number): string | undefined {
  return deps.db.getProject(projectId)?.root_path ?? undefined;
}
