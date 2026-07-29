#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildContext } from './context.js';
import { allTools, buildToolRegistry } from './tools/index.js';
import { allResources, collectListedResources, readResource } from './resources/index.js';
import { coerceArgs } from './utils.js';
import { VERSION, PACKAGE_NAME } from '@mcp/shared/version.js';
import { disposeIndexerProcessResources } from '@mcp/indexer/bootstrap/dispose.js';
import { normalizeMcpToolResult } from './tool.js';

const ctx = buildContext();
const registry = buildToolRegistry();

const server = new Server(
  { name: PACKAGE_NAME, version: VERSION },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      'CodeStudio exposes project-aware code navigation, documentation, memory and controlled agent execution. ' +
      'Start with read-only bootstrap tools and pass project_name when requested.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map(({ name, description, inputSchema, annotations }) => ({
    name, description, inputSchema, annotations,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const tool = registry.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const args = coerceArgs((rawArgs ?? {}) as Record<string, unknown>);
    const result = normalizeMcpToolResult(await tool.handler(args, ctx));
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
      ...(result.sourceTruncations?.length
        ? { _meta: { sourceTruncations: result.sourceTruncations } }
        : {}),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

// ── MCP resources ───────────────────────────────────────────────────
// Stdio transport has no auth — `authCtx` is always undefined here. The HTTP
// transport mirrors these handlers with scope enforcement (see
// http/mcp-http-transport.ts).

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: await collectListedResources(ctx),
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: allResources.map((r) => ({
    uriTemplate: r.uriTemplate,
    name: r.name,
    description: r.description,
    ...(r.mimeType ? { mimeType: r.mimeType } : {}),
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const result = await readResource(uri, ctx);
  if (!result) {
    throw new Error(`Resource not found: ${uri}`);
  }
  return {
    contents: result.contents.map((c) =>
      c.type === 'text'
        ? { uri, mimeType: c.mimeType ?? result.resource.mimeType ?? 'text/plain', text: c.text }
        : { uri, mimeType: c.mimeType ?? result.resource.mimeType ?? 'application/octet-stream', blob: c.blob },
    ),
  };
});

async function main() {
  const transport = new StdioServerTransport();
  process.on('SIGINT', () => {
    void disposeIndexerProcessResources().finally(() => process.exit(0));
  });
  await server.connect(transport);
  // Stdio close = host went away. Drain tree-sitter workers before exiting;
  // session bundles flush through their independent per-session writers.
  // (`server.onclose` — the SDK overwrites `transport.onclose` on connect.)
  server.onclose = () => {
    void disposeIndexerProcessResources().finally(() => process.exit(0));
  };
  console.error(
    `MCP Code Indexer server running on stdio (${allTools.length} tools, ${allResources.length} resources)`,
  );
}

main().catch(console.error);
