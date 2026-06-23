import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { ToolContext } from './context.js';

/**
 * MCP resources sit alongside tools — the client can list/read them without
 * the agent emitting tool calls. The factory here mirrors `defineTool` so a
 * new resource is plug-and-play: drop a `defineResource({...})` into a file
 * under resources/, append it in resources/index.ts.
 *
 * Each resource declares a URI template (RFC 6570). The aggregate handlers
 * in apps/mcp-server/index.ts and apps/mcp-server/http/mcp-http-transport.ts
 * try each resource in order on a `resources/read` request; the first whose
 * `read()` returns non-null wins. `list()` returns concrete instances for
 * the static `resources/list` response — return [] to keep the resource as
 * template-only (used for snapshots, where listing every snapshot in every
 * project would scale poorly).
 */

export type ResourceContent =
  | { type: 'text'; text: string; mimeType?: string }
  | { type: 'blob'; blob: string; mimeType?: string };

export interface ListedResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResource {
  /** RFC 6570 URI template, e.g. `mcp://project/{name}/overview`. */
  uriTemplate: string;
  /** Stable identifier shown to the client (mirrors tool.name). */
  name: string;
  /** Human-readable description shown alongside the template. */
  description: string;
  /** Default MIME type returned by `read`. Resources can override per-call. */
  mimeType?: string;
  /**
   * Scope required to read this resource. Defaults to `mcp:read`. Enforced
   * by the HTTP transport when auth is enabled; stdio has no auth and always
   * passes.
   */
  scope?: string;
  /**
   * Enumerate concrete resources matching this template. Used to populate
   * `resources/list`. Return an empty array to keep the resource hidden from
   * listing (still readable via the template URI).
   */
  list(ctx: ToolContext, authCtx?: AuthContext): Promise<ListedResource[]>;
  /**
   * Match a URI against this template's pattern and return its contents.
   * Return `null` when the URI does not belong to this template — the
   * aggregate handler will try the next resource in registration order.
   */
  read(
    uri: string,
    ctx: ToolContext,
    authCtx?: AuthContext,
  ): Promise<ResourceContent[] | null>;
}

export function defineResource(r: McpResource): McpResource {
  return r;
}
