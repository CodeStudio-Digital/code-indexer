#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildContext } from './context.js';
import { allTools, buildToolRegistry } from './tools/index.js';
import { coerceArgs } from './utils.js';
import { VERSION, PACKAGE_NAME } from '../../version.js';

const ctx = buildContext();
const registry = buildToolRegistry();

const server = new Server(
  { name: PACKAGE_NAME, version: VERSION },
  { capabilities: { tools: {} } },
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MCP Code Indexer server running on stdio (${allTools.length} tools)`);
}

main().catch(console.error);
