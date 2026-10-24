/**
 * MCP resource tools — companions to the `mcp__*` tool bridge.
 *
 * The MCP protocol distinguishes tools (callable functions) from resources
 * (URI-addressable read-only content like file skeletons, doc snippets,
 * cached search artifacts). Our existing bridge only surfaces tools; this
 * module adds two native helpers so the agent can list and read resources
 * the connected server exposes — without the caller paying for a tool call
 * just to GET static content.
 *
 * Inspired by codex's `mcp_resource_tool`. Limited to the primary internal
 * bridge for now; external MCP servers (admin-configured) keep their own
 * tools-only path until a real use case appears.
 */
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { McpToolBridge } from '@mcp/code-agent/tools/mcp-bridge.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

const LIST_RESOURCES_DESC =
  'List static resources and URI templates exposed by the MCP bridge. ' +
  'Resources are read-only content addressable by URI (file skeletons, doc snippets, cached artifacts). ' +
  'Cheaper than calling a tool when the server already publishes the content as a resource.\n' +
  "USE: when you suspect the server may publish a resource for what you're after — call this once to discover URIs.\n" +
  "DON'T: call repeatedly per turn. Cache the URIs you care about.";

const READ_RESOURCE_DESC =
  'Read the contents of an MCP resource by URI. Pair with mcp_list_resources to discover available URIs.\n' +
  "USE: after mcp_list_resources surfaced a URI you want to read.\n" +
  "DON'T: invent URIs — only read URIs you saw in mcp_list_resources or that the user/server documented.";

export function buildMcpResourceTools(bridge: McpToolBridge): CoderTool[] {
  const listResources: CoderTool = {
    name: 'mcp_list_resources',
    description: maybeTerse(LIST_RESOURCES_DESC),
    source: 'native',
    mutates: false,
    parallelSafe: true,
    riskLevel: 'read',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['all', 'resources', 'templates'], description: 'Default all. Select one kind to follow its next cursor.' },
      cursor: { type: 'string', description: 'Opaque next cursor returned by the server for the selected kind.' },
    }, additionalProperties: false },
    handler: async (args, ctx): Promise<ToolResult> => {
      try {
        const kind = args.kind ?? 'all';
        if (kind !== 'all' && kind !== 'resources' && kind !== 'templates') return err('Invalid resource kind.');
        const cursor = args.cursor;
        if (cursor != null && (typeof cursor !== 'string' || cursor.length > 8192 || kind === 'all')) return err('cursor requires one kind and at most 8192 characters.');
        ctx.signal?.throwIfAborted();
        const { resources, templates, nextResourceCursor, nextTemplateCursor } = await bridge.listResources({ kind, cursor: cursor as string | undefined, signal: ctx.signal });
        ctx.signal?.throwIfAborted();
        if (resources.length === 0 && templates.length === 0 && nextResourceCursor == null && nextTemplateCursor == null) {
          return ok('(no resources or templates exposed by the MCP server)');
        }
        const lines: string[] = [];
        if (resources.length > 0) {
          lines.push(`# Resources (${resources.length})`);
          for (const r of resources) {
            const desc = r.description ? ` — ${r.description}` : '';
            const mime = r.mimeType ? ` [${r.mimeType}]` : '';
            lines.push(`- ${r.uri}${mime}: ${r.name}${desc}`);
          }
        }
        if (templates.length > 0) {
          if (lines.length > 0) lines.push('');
          lines.push(`# Resource templates (${templates.length})`);
          for (const t of templates) {
            const desc = t.description ? ` — ${t.description}` : '';
            const mime = t.mimeType ? ` [${t.mimeType}]` : '';
            lines.push(`- ${t.uriTemplate}${mime}: ${t.name}${desc}`);
          }
        }
        if (nextResourceCursor != null) lines.push('Continue resources: mcp_list_resources(' + JSON.stringify({ kind: 'resources', cursor: nextResourceCursor }) + ').');
        if (nextTemplateCursor != null) lines.push('Continue templates: mcp_list_resources(' + JSON.stringify({ kind: 'templates', cursor: nextTemplateCursor }) + ').');
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`mcp_list_resources failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const readResource: CoderTool = {
    name: 'mcp_read_resource',
    description: maybeTerse(READ_RESOURCE_DESC),
    source: 'native',
    mutates: false,
    parallelSafe: true,
    riskLevel: 'read',
    parameters: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'Resource URI as returned by mcp_list_resources.' },
      },
      required: ['uri'],
      additionalProperties: false,
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const uri = String(args.uri ?? '').trim();
      if (!uri) return err('uri cannot be empty');
      if (uri.length > 8192) return err('uri must be at most 8192 characters');
      try {
        ctx.signal?.throwIfAborted();
        const { contents, mimeType } = await bridge.readResource(uri, ctx.signal);
        ctx.signal?.throwIfAborted();
        const header = mimeType ? `${uri} [${mimeType}]\n` : `${uri}\n`;
        return ok(header + contents);
      } catch (e) {
        return err(
          `mcp_read_resource failed for '${uri}': ${e instanceof Error ? e.message : String(e)}. ` +
            `Verify the URI via mcp_list_resources.`,
        );
      }
    },
  };

  return [listResources, readResource];
}
