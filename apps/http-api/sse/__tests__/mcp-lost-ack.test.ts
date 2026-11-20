import { createServer } from 'node:http';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { McpExternalPool } from '../McpExternalPool.js';
import { registerWorkerMcpCalls } from '../worker-mcp-calls.js';
import { RemoteMcpServerManager } from '../../workers/RemoteMcpServerManager.js';
import { MessageBridge } from '@mcp/orchestrator-host';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { dispatchTools } from '@mcp/code-agent/core/runner/nodes/executing-dispatch.js';

it('sends one real HTTP mutation when the server executes it then drops the ACK', async () => {
  let mutations = 0, discoveries = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'lost-ack-fixture', version: '1' } };
    else if (message.method === 'tools/list') {
      discoveries++;
      result = { tools: [{ name: 'mutate', inputSchema: { type: 'object', properties: {} } }] };
    } else if (message.method === 'tools/call') {
      mutations++;
      response.destroy(); // side effect exists, client receives no result
      return;
    } else result = {};
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing server port');
  const config: McpServerConfig = { id: 'lostack', name: 'fixture', transport: 'streamable_http', enabled: true,
    url: `http://127.0.0.1:${address.port}/mcp`, command: null, args: [], env: {}, auth_type: 'none',
    auth_token: null, default_tier: 'core', config: {}, created_at: '', updated_at: '' };
  const pool = new McpExternalPool({ dbPath: ':memory:', loadEnabledServers: () => [config] });
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 });
  const worker = new MessageBridge({ port: channel.port2 });
  const off = registerWorkerMcpCalls(main, () => pool);
  main.handle('mcpExt.snapshot', () => pool.getSnapshot());
  try {
    await pool.boot();
    const manager = new RemoteMcpServerManager(worker); await manager.connectAll([]);
    const { tools } = await manager.listAllTools();
    expect(tools).toHaveLength(1);
    const registry = new ToolRegistry(); registry.registerAll(tools);
    const calls = [1, 2].map(index => ({ id: `call-${index}`, name: tools[0].name, input: {} }));
    const output = await dispatchTools({ registry, toolContext: {
      cwd: process.cwd(), projectName: 'lost-ack', toolCallLedger: new ToolCallLedger(),
    }, turn: 1, toolUses: calls });
    expect(output.outcomeUnknown).toBe(true);
    expect(output.results[0].effectOutcome).toBe('unknown');
    expect(output.results[1].refusalKind).toBe('gate');
    expect(mutations).toBe(1);
    expect(discoveries).toBe(1);
  } finally {
    off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close();
    await pool.shutdown(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15_000);
