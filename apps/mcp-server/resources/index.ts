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
 * `resources/list` request. Flatten each resource's `list()` output. Errors
 * from a single resource are isolated — a misbehaving resource shouldn't
 * blank the whole catalog.
 */
export async function collectListedResources(
  ctx: ToolContext,
  authCtx?: AuthContext,
): Promise<ListedResource[]> {
  const out: ListedResource[] = [];
  for (const r of allResources) {
    try {
      const items = await r.list(ctx, authCtx);
      out.push(...items);
    } catch (err) {
      console.error(`[mcp-resources] list failed for ${r.name}:`, (err as Error).message);
    }
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
    try {
      const contents = await r.read(uri, ctx, authCtx);
      if (contents !== null) return { resource: r, contents };
    } catch (err) {
      console.error(`[mcp-resources] read failed for ${r.name} on ${uri}:`, (err as Error).message);
      // Continue trying — a thrown error from one matcher shouldn't block
      // another resource's chance to handle the URI.
    }
  }
  return null;
}
