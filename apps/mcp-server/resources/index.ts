import type { McpResource, ResourceContent, ListedResource } from '../resource.js';
import type { ToolContext } from '../context.js';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import { projectResources } from './projects.js';
import { snapshotResources } from './snapshots.js';

/**
 * All MCP resources exposed by this server, grouped by domain.
 * To add a new resource: create a `defineResource({...})` in a file under
 * resources/ (or a new file) and append it to this list.
 */
export const allResources: McpResource[] = [
  ...projectResources,
  ...snapshotResources,
];

/** Default scope when a resource doesn't declare one. Resources are reads. */
export const DEFAULT_RESOURCE_SCOPE = 'mcp:read';

/**
 * Helper used by both transports (stdio + HTTP) to satisfy a
 * `resources/list` request. Flatten each resource's `list()` output. Failures
 * propagate: a partial/empty catalog must not masquerade as a complete page.
 */
export async function collectListedResources(
  ctx: ToolContext,
  authCtx?: AuthContext,
): Promise<ListedResource[]> {
  const out: ListedResource[] = [];
  for (const r of allResources) {
    const items = await r.list(ctx, authCtx);
    out.push(...items);
  }
  return out;
}

/**
 * Helper used by both transports to satisfy a `resources/read` request.
 * Tries each resource in registration order; the first non-null result
 * wins. Returns null when no resource matches the URI (the caller maps
 * that to a proper MCP error).
 */
export async function readResource(
  uri: string,
  ctx: ToolContext,
  authCtx?: AuthContext,
): Promise<{ resource: McpResource; contents: ResourceContent[] } | null> {
  for (const r of allResources) {
    // Matchers return null for unrelated URIs. A failure reading a matching
    // resource must reach the transport as an error, never a false 404.
    const contents = await r.read(uri, ctx, authCtx);
    if (contents !== null) return { resource: r, contents };
  }
  return null;
}
