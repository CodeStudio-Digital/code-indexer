import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { DeferredMcpValidator } from '../deferred-mcp-validator.js';

afterEach(() => vi.restoreAllMocks());
const outputSchema = { type: 'object' as const, properties: { count: { type: 'integer' as const } }, required: ['count'] };

describe('deferred MCP output validation', () => {
  it('lists and refreshes a real SDK catalogue without compiling; rejects invalid tool output', async () => {
    const compile = vi.spyOn(AjvJsonSchemaValidator.prototype, 'getValidator');
    const client = new Client({ name: 'fixture', version: '1' }, { jsonSchemaValidator: new DeferredMcpValidator() });
    const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`, inputSchema: { type: 'object' as const }, outputSchema: structuredClone(outputSchema),
    })) }));
    let result: unknown = { count: 4 };
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [], structuredContent: result }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools).toHaveLength(200);
      await client.listTools();
      expect(compile).not.toHaveBeenCalled();
      expect((await client.callTool({ name: 'tool_0' })).structuredContent).toEqual({ count: 4 });
      expect(compile).toHaveBeenCalledTimes(1);
      await client.listTools();
      await client.callTool({ name: 'tool_1' });
      expect(compile).toHaveBeenCalledTimes(1);
      result = { count: 'wrong' };
      await expect(client.callTool({ name: 'tool_0' })).rejects.toThrow(/does not match.*output schema/i);
      result = {};
      await expect(client.callTool({ name: 'tool_0' })).rejects.toThrow(/does not match.*output schema/i);
    } finally { await client.close(); await server.close(); }
  });

  it('does not reuse a changed schema by $id or weaken references and formats', () => {
    const provider = new DeferredMcpValidator();
    const first = provider.getValidator({ ...outputSchema, $id: 'urn:tool:result' });
    const changed = provider.getValidator({ ...outputSchema, $id: 'urn:tool:result', properties: { count: { type: 'string' } } });
    expect(first({ count: 1 }).valid).toBe(true);
    expect(changed({ count: 1 }).valid).toBe(false);
    expect(changed({ count: 'one' }).valid).toBe(true);
    const nested = provider.getValidator({ type: 'object', properties: { url: { $ref: '#/$defs/url' } },
      required: ['url'], $defs: { url: { type: 'string', format: 'uri' } } });
    expect(nested({ url: 'https://example.org' }).valid).toBe(true);
    expect(nested({ url: 'not a uri' }).valid).toBe(false);
    expect(() => provider.getValidator({ type: 'invalid' } as never)({})).toThrow();
  });

  it('bounds compiled schemas and still validates a schema after eviction', () => {
    const compile = vi.spyOn(AjvJsonSchemaValidator.prototype, 'getValidator');
    const provider = new DeferredMcpValidator();
    const first = provider.getValidator({ type: 'number', minimum: 0 });
    first(0);
    for (let minimum = 1; minimum <= 32; minimum++) provider.getValidator({ type: 'number', minimum })(minimum);
    expect(first(-1).valid).toBe(false);
    expect(compile).toHaveBeenCalledTimes(34);
  });
});
