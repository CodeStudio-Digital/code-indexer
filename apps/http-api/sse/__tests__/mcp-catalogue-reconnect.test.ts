import { createServer } from 'node:http';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { McpExternalPool } from '../McpExternalPool.js';
import { registerWorkerMcpCalls } from '../worker-mcp-calls.js';
import { RemoteMcpServerManager } from '../../workers/RemoteMcpServerManager.js';

it('two existing workers recover the same real HTTP MCP after its catalogue was temporarily offline', async () => {
  let online = true, changed = false, effects = 0, discoveries = 0, snapshotRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'reloading-fixture', version: '1' } };
    else if (message.method === 'tools/list') {
      discoveries++;
      if (!online) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Editor reloading' } }));
        return;
      }
      result = { tools: [{ name: 'write', description: 'Create a fixture asset.', inputSchema: {
        type: 'object', properties: changed ? { name: { type: 'string' } } : {},
      } }] };
    } else if (message.method === 'tools/call') {
      effects++; result = { content: [{ type: 'text', text: 'created once' }] };
    } else result = {};
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
  const config: McpServerConfig = { id: 'fixture', name: 'fixture', transport: 'streamable_http', enabled: true,
    url: `http://127.0.0.1:${address.port}/mcp`, command: null, args: [], env: {}, auth_type: 'none',
    auth_token: null, default_tier: 'core', config: {}, created_at: '', updated_at: '' };
  const pool = new McpExternalPool({ dbPath: ':memory:', loadEnabledServers: () => [config] });
  const clients = [1, 2].map(() => {
    const channel = new MessageChannel();
    const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
    const off = registerWorkerMcpCalls(main, () => pool);
    main.handle('mcpExt.snapshot', () => { snapshotRequests++; return pool.getReadySnapshot(); });
    return { channel, main, worker, off, manager: new RemoteMcpServerManager(worker) };
  });
  try {
    await pool.boot();
    await Promise.all(clients.map(client => client.manager.connectAll([])));
    const tools = await Promise.all(clients.map(async client => (await client.manager.listAllTools()).tools[0]));
    const revision = pool.getSnapshot().tools[0].catalogueRevision;
    online = false;
    await expect(pool.refreshServer('fixture')).rejects.toThrow();
    expect(pool.getSnapshot().tools).toEqual([]);
    const unavailable = await tools[0].handler({}, {} as ToolContext);
    expect(unavailable).toMatchObject({ isError: true, error: { code: 'MCP_UNAVAILABLE' } });
    expect(unavailable.effectOutcome).toBeUndefined();
    expect(effects).toBe(0);
    online = true;
    config.updated_at = '2026-11-12T00:00:00.000Z';
    const listsBeforeRecovery = discoveries;
    const results = await Promise.all(tools.map(tool => tool.handler({}, {} as ToolContext)));
    expect(results.every(result => !result.isError && result.content.includes('created once'))).toBe(true);
    expect(effects).toBe(2); // One effect for each new call; no replay.
    expect(discoveries).toBe(listsBeforeRecovery + 1); // Shared reconciliation, not one reconnect per worker.
    expect(snapshotRequests).toBe(2); // Both workers still hold their original catalogues.
    expect(pool.getSnapshot().tools[0].catalogueRevision).toBe(revision);
    changed = true; await pool.refreshServer('fixture');
    expect(await tools[0].handler({}, {} as ToolContext)).toMatchObject({ isError: true, error: { code: 'MCP_CATALOGUE_CHANGED' } });
    expect(effects).toBe(2); // A changed contract was not dispatched under old admission.
  } finally {
    for (const client of clients) {
      client.off(); client.main.dispose(); client.worker.dispose(); client.channel.port1.close(); client.channel.port2.close();
    }
    await pool.shutdown(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15_000);
