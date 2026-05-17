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
import { backfillSnapshotEmbeddings } from '@mcp/services/services/snapshot-backfill.js';

const ctx = buildContext();
const registry = buildToolRegistry();

/**
 * Background reconciliation: any project whose snapshot count exceeds its
 * snapshot-vector count gets the missing rows embedded. Skips silently when
 * no embedding backend is configured. The work is intentionally fire-and-
 * forget — boot continues immediately so the stdio handshake isn't blocked.
 */
function scheduleSnapshotBackfill(): void {
  if (!ctx.snapshotService.hasEmbeddingBackend()) return;
  void (async () => {
    try {
      const projects = ctx.db.listProjects();
      for (const p of projects) {
        const total = ctx.db.countSnapshots(p.id);
        if (total === 0) continue;
        const indexed = ctx.db.countSnapshotVectors(p.id);
        if (indexed >= total) continue;
        const result = await backfillSnapshotEmbeddings(ctx.db, ctx.snapshotService, p.id);
        if (result.embedded > 0 || result.failed > 0) {
          console.error(
            `[snapshot-backfill] project=${p.name} embedded=${result.embedded} failed=${result.failed} skipped=${result.skipped}`,
          );
        }
      }
    } catch (err) {
      console.error('[snapshot-backfill] error:', (err as Error).message);
    }
  })();
}

const server = new Server(
  { name: PACKAGE_NAME, version: VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const tool = registry.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const args = coerceArgs((rawArgs ?? {}) as Record<string, unknown>);
    const result = await tool.handler(args, ctx);
    return { content: [{ type: 'text', text: result }] };
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
  await server.connect(transport);
  console.error(
    `MCP Code Indexer server running on stdio (${allTools.length} tools, ${allResources.length} resources)`,
  );
  scheduleSnapshotBackfill();
}

main().catch(console.error);
