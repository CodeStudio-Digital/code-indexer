import { app } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { DeferredMcpValidator } from '../../../packages/code-agent/src/tools/deferred-mcp-validator.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const schema = { type: 'object' as const, properties: Object.fromEntries(Array.from({ length: 48 }, (_, i) =>
  [`field_${i}`, { anyOf: [{ type: 'string', maxLength: 1024 }, { type: 'array', items: { type: 'object',
    properties: { id: { type: 'integer' }, label: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id'] } }] }])),
  required: ['field_0'] };

async function measure(variant: string, validator: jsonSchemaValidator) {
  const client = new Client({ name: 'benchmark', version: '1' }, { jsonSchemaValidator: validator });
  const server = new Server({ name: 'synthetic-catalog', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Array.from({ length: 240 }, (_, i) => ({
    name: `tool_${i}`, inputSchema: { type: 'object' as const }, outputSchema: structuredClone(schema),
  })) }));
  let output: unknown = { field_0: 'valid' };
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [], structuredContent: output }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const rounds = [];
    for (let round = 0; round < 2; round++) {
      let previous = performance.now(), maxBlockMs = 0;
      const heartbeat = setInterval(() => { const now = performance.now(); maxBlockMs = Math.max(maxBlockMs, now - previous - 5); previous = now; }, 5);
      await sleep(25);
      const started = performance.now();
      const listed = await client.listTools();
      const elapsedMs = performance.now() - started;
      await sleep(25); clearInterval(heartbeat);
      rounds.push({ round, tools: listed.tools.length, elapsedMs, maxBlockMs });
    }
    const callStart = performance.now();
    await client.callTool({ name: 'tool_0' });
    const firstValidatedCallMs = performance.now() - callStart;
    output = { field_0: 123 };
    let rejectedInvalid = false;
    try { await client.callTool({ name: 'tool_0' }); } catch { rejectedInvalid = true; }
    if (!rejectedInvalid) throw new Error('Invalid output was accepted');
    return { variant, rounds, firstValidatedCallMs, rejectedInvalid };
  } finally { await client.close(); await server.close(); }
}

app.setPath('userData', join(__dirname, 'benchmark-profile'));
void app.whenReady().then(async () => {
  const results = [];
  results.push(await measure('before-eager', new AjvJsonSchemaValidator()));
  results.push(await measure('after-deferred', new DeferredMcpValidator()));
  const report = { electron: process.versions.electron, node: process.version,
    scope: 'real Electron main + MCP SDK, synthetic 240-tool catalogue; no user data or external server', results };
  await writeFile(join(__dirname, 'mcp-catalog-benchmark.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
