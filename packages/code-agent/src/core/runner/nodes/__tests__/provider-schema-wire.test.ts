import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { ChatGPTCodexProvider } from '../../../../providers/chatgpt.js';
import { ToolRegistry } from '../../../registry.js';
import { ToolCallLedger } from '../../../tool-call-ledger.js';
import { ok, type ToolContext } from '../../../tool.js';
import { buildFindToolsTool } from '../../../../tools/find-tools.js';
import { buildCodeExecTool } from '../../../../tools/code-exec.js';
import { sanitizeUntrustedCapabilityMetadata } from '@mcp/shared';
import rea from '@mcp/shared/utils/__tests__/fixtures/rea-capture-browser-scenario.schema.json' with { type: 'json' };
import { makeTestContext } from './test-helpers.js';
import { runBehaviorTree } from '../../orchestrator.js';

const name = 'ext_rea__capture_browser_scenario';

it.each(['valid', 'sse-rejection', 'http-rejection'])('runs discovery through real Responses HTTP transport: %s', async mode => {
  const registry = new ToolRegistry(), pins = new Set<string>();
  const rejectedHandler = vi.fn(async () => ok('synthetic capture complete'));
  registry.register({ name, source: 'mcp_external', description: 'Capture a controlled browser scenario',
    parameters: sanitizeUntrustedCapabilityMetadata('', rea).schema as never,
    mutates: false, riskLevel: 'read', parallelSafe: true, handler: rejectedHandler });
  const tiers = new Map([[name, 'rea']]);
  registry.register(buildFindToolsTool(registry, tiers));
  registry.register(buildCodeExecTool(registry));
  const runner = { stableToolCatalog: true, visibleToolNames: new Set<string>(), requestedToolNames: pins, pinnedTools: pins,
    promoteTool(tool: string) { pins.add(tool); return []; } };
  const bodies: Array<{ tools: Array<{ name: string; parameters: unknown }>; instructions?: string; input: unknown[] }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const attempt = bodies.length;
    const send = (event: Record<string, unknown>) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (attempt === 2 && mode === 'http-rejection') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_function_parameters',
        message: `Invalid schema for function '${name}': null is not of types "boolean", "object"` } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempt === 2 && mode === 'sse-rejection') {
      // Match the screenshot: an SSE failure with neither status nor code.
      send({ type: 'error', message: `Invalid schema for function '${name}': null is not of types "boolean", "object"` });
      response.end(); return;
    }
    let tool: string | undefined, args: Record<string, unknown> = {};
    if (attempt === 1) { tool = 'find_tools'; args = { query: 'capture_browser_scenario', limit: 1 }; }
    else if (mode === 'valid' && attempt === 2) { tool = 'code_exec'; args = { code: `return await tools.${name}({actions:[]})` }; }
    else if (mode !== 'valid' && attempt === 3) { tool = 'find_tools'; args = { query: 'capture_browser_scenario', limit: 1 }; }
    else if (mode !== 'valid' && attempt === 4) {
      tool = 'code_exec'; args = { code: `return await tools.${name}({actions:[]})` };
    }
    if (tool) {
      const item = { type: 'function_call', id: `item_${attempt}`, call_id: `call_${attempt}`, name: tool, arguments: JSON.stringify(args) };
      send({ type: 'response.output_item.added', item });
      send({ type: 'response.output_item.done', item });
    } else send({ type: 'response.output_text.delta', delta: 'Verified schema recovery completed.' });
    send({ type: 'response.completed', response: { status: 'completed' } }); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  try {
    const { ctx, recordedEvents } = makeTestContext({ registry, maxTurns: 8,
      toolContext: { cwd: process.cwd(), projectName: 'schema-fixture', runner,
        toolCallLedger: new ToolCallLedger() } as unknown as ToolContext,
      provider: new ChatGPTCodexProvider({ apiKey: 'local-only', baseURL: `http://127.0.0.1:${address.port}`, model: 'local-fixture' }),
    });
    ctx.opts.externalToolTiers = tiers;
    // A real provider rejection can concern only a published schema. Hidden
    // discovery stays stable; explicitly configured top-level tools still
    // exercise both rejection transports and the authorized generic fallback.
    if (mode !== 'valid') ctx.opts.requiredPinnedTools = [name];
    const result = await runBehaviorTree({ opts: ctx.opts, emit: ctx.emit, initialTiers: new Set(['bootstrap']) });
    expect(result.reason).toBe('completed');
    expect(bodies).toHaveLength(mode === 'valid' ? 3 : 5);
    expect(bodies[0].tools.some(t => t.name === name)).toBe(mode !== 'valid');
    if (mode === 'valid') {
      expect(bodies[1].tools).toEqual(bodies[0].tools);
      expect(bodies.every(body => !body.tools.some(tool => tool.name === name))).toBe(true);
      const discoveryOutput = (bodies[1].input as Array<{ type: string; output?: string }>).find(item => item.type === 'function_call_output')?.output;
      const schemaLine = discoveryOutput?.split(`${name} input schema: `)[1]?.split('\n')[0];
      expect(schemaLine).toBeDefined();
      expect(JSON.parse(schemaLine!)).toEqual(registry.get(name)!.parameters);
    } else expect(bodies[1].tools.find(t => t.name === name)?.parameters).toEqual(rea);
    expect(rejectedHandler).toHaveBeenCalledTimes(1);
    if (mode !== 'valid') {
      for (const body of bodies.slice(2)) {
        expect(body.tools.some(t => t.name === name)).toBe(false);
        expect(body.instructions).toContain('<tool-schema-compatibility>');
      }
      expect(JSON.stringify(bodies[3].input)).toContain('schema rejected by current provider');
      expect(recordedEvents.some(e => e.event === 'recovery_aborted')).toBe(false);
    }
    expect(registry.get(name)).toBeDefined(); // the authorized code_exec bridge stays intact
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
