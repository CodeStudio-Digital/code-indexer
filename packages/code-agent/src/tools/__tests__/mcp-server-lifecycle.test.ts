import { createServer, type ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { McpServerManager } from '../mcp-server-manager.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { ResolveMcpBearer } from '@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js';
import type { ToolContext } from '../../core/tool.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(transport: 'streamable_http' | 'sse' = 'streamable_http') {
  const state = { initialized: 0, called: 0, dropped: false, redirect: false, hold: undefined as Promise<void> | undefined,
    // Streamable HTTP sessions: issued on initialize when enabled, and the ids each DELETE ended.
    sessions: false, deleted: [] as string[], deleteStatus: 204 as number | 'hang' };
  let events: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    if (transport === 'sse' && request.method === 'GET') {
      events = response; response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    if (request.method === 'DELETE' && state.sessions) {
      state.deleted.push(String(request.headers['mcp-session-id']));
      if (state.deleteStatus !== 'hang') response.writeHead(state.deleteStatus).end();
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown = {};
    if (message.method === 'initialize') {
      state.initialized++;
      if (state.hold) await state.hold;
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'lifecycle', version: '1' } };
    } else if (message.method === 'tools/list') result = { tools: [{ name: 'write', inputSchema: { type: 'object' } }] };
    else if (message.method === 'tools/call') {
      state.called++;
      if (state.redirect) { response.writeHead(307, { location: '/redirected' }).end(); return; }
      if (state.dropped) { response.destroy(); return; }
      result = { content: [{ type: 'text', text: 'ok' }] };
    }
    if (response.destroyed) return;
    const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    if (transport === 'sse') { response.writeHead(202).end(); events!.write('event: message\ndata: ' + reply + '\n\n'); }
    else response.writeHead(200, { 'content-type': 'application/json',
      ...(state.sessions && message.method === 'initialize' ? { 'mcp-session-id': 'session-' + state.initialized } : {}) }).end(reply);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
  const config: McpServerConfig = { id: 'fixture', name: 'fixture', transport, enabled: true,
    url: 'http://127.0.0.1:' + address.port + '/mcp', command: null, args: [], env: {}, auth_type: 'none', auth_token: null,
    default_tier: 'core', config: {}, created_at: '', updated_at: '' };
  return { state, config, async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}

it('retires a real pending handshake before close returns and never resurrects it', async () => {
  const f = await fixture(), gate = deferred(); f.state.hold = gate.promise;
  const manager = new McpServerManager();
  try {
    const pending = manager.connectServer(f.config).then(() => 'connected', () => 'closed');
    await vi.waitFor(() => expect(f.state.initialized).toBe(1));
    await manager.closeAll();
    expect(await pending).toBe('closed');
    gate.resolve();
    await new Promise<void>(r => setImmediate(r));
    expect(manager.connectedCount).toBe(0);
    expect(manager.getConnectionStates().size).toBe(0);
    expect(f.state.called).toBe(0);
  } finally { gate.resolve(); await manager.closeAll(); await f.close(); }
});

it('does not open a transport when OAuth resolution finishes after shutdown', async () => {
  const f = await fixture(), gate = deferred<{ ok: true; value: string }>();
  const execute = vi.fn(() => gate.promise);
  const manager = new McpServerManager({ execute } as unknown as ResolveMcpBearer);
  try {
    const pending = manager.connectServer({ ...f.config, auth_type: 'oauth2' }).then(() => 'connected', () => 'closed');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await manager.closeAll();
    expect(await pending).toBe('closed');
    gate.resolve({ ok: true, value: 'fixture-only' });
    await new Promise<void>(r => setImmediate(r));
    expect(f.state.initialized).toBe(0);
    expect(manager.connectedCount).toBe(0);
  } finally { gate.resolve({ ok: true, value: 'fixture-only' }); await manager.closeAll(); await f.close(); }
});

it('shares one handshake and rejects a tool whose configuration was replaced', async () => {
  const f = await fixture(); const manager = new McpServerManager();
  try {
    await Promise.all(Array.from({ length: 4 }, () => manager.connectServer(f.config)));
    expect(f.state.initialized).toBe(1);
    const old = (await manager.listAllTools()).tools[0];
    await manager.connectServer({ ...f.config, config: { changed: true } });
    expect(await old.handler({}, {} as ToolContext)).toMatchObject({ isError: true });
    expect(f.state.called).toBe(0);
    const current = (await manager.listAllTools()).tools[0];
    expect(await current.handler({}, {} as ToolContext)).toMatchObject({ content: 'ok' });
    expect(f.state.called).toBe(1);
  } finally { await manager.closeAll(); await f.close(); }
});

it('closes a lazy reconnect without sending a second effect', async () => {
  const f = await fixture(), gate = deferred(); const manager = new McpServerManager();
  try {
    await manager.connectServer(f.config);
    const tool = (await manager.listAllTools()).tools[0];
    f.state.dropped = true;
    expect(await tool.handler({}, {} as ToolContext)).toMatchObject({ effectOutcome: 'unknown' });
    f.state.hold = gate.promise;
    const second = tool.handler({}, {} as ToolContext);
    await vi.waitFor(() => expect(f.state.initialized).toBe(2));
    await manager.closeAll(); gate.resolve();
    expect(await second).toMatchObject({ isError: true });
    expect(f.state.called).toBe(1);
    expect(manager.connectedCount).toBe(0);
  } finally { gate.resolve(); await manager.closeAll(); await f.close(); }
});

it('rechecks run ownership at wire dispatch after an asynchronous reconnect', async () => {
  const f = await fixture(), gate = deferred(); const manager = new McpServerManager();
  let live = true;
  const assertExternalMcpDispatch = vi.fn(() => { if (!live) throw Error('run retired'); });
  try {
    await manager.connectServer(f.config);
    const tool = (await manager.listAllTools()).tools[0];
    // A failed health probe leaves an existing catalogue eligible for pre-call reconnect.
    (manager as unknown as { connections: Map<string, { state: string }> }).connections.get(f.config.id)!.state = 'disconnected';
    f.state.hold = gate.promise;
    const pending = tool.handler({}, { assertExternalMcpDispatch, cwd: process.cwd(), projectName: 'fixture' });
    await vi.waitFor(() => expect(f.state.initialized).toBe(2));
    live = false; gate.resolve();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.effectOutcome).toBeUndefined();
    expect(assertExternalMcpDispatch).toHaveBeenCalledTimes(1);
    expect(f.state.called).toBe(0);
  } finally { gate.resolve(); await manager.closeAll(); await f.close(); }
});


it.each(['streamable_http', 'sse'] as const)('denies an effect when ownership changes during SDK header preparation: %s', async transport => {
  const f = await fixture(transport), manager = new McpServerManager();
  let live = true;
  const assertExternalMcpDispatch = vi.fn(() => {
    if (!live) throw Error('run retired');
    queueMicrotask(() => { live = false; });
  });
  try {
    await manager.connectServer(f.config);
    const tool = (await manager.listAllTools()).tools[0];
    const result = await tool.handler({}, { assertExternalMcpDispatch, cwd: process.cwd(), projectName: 'fixture' });
    expect(result.isError).toBe(true);
    expect(result.effectOutcome).toBeUndefined();
    expect(assertExternalMcpDispatch).toHaveBeenCalledTimes(2);
    expect(f.state.called).toBe(0);
  } finally { await manager.closeAll(); await f.close(); }
});


it.each(['streamable_http', 'sse'] as const)('never replays a tool POST after an HTTP redirect: %s', async transport => {
  const f = await fixture(transport), manager = new McpServerManager();
  try {
    await manager.connectServer(f.config);
    const tool = (await manager.listAllTools()).tools[0];
    f.state.redirect = true;
    expect(await tool.handler({}, {} as ToolContext)).toMatchObject({ effectOutcome: 'unknown' });
    expect(f.state.called).toBe(1);
  } finally { await manager.closeAll(); await f.close(); }
});

it('keeps concurrent dispatch authority isolated on a shared connection', async () => {
  const f = await fixture(), manager = new McpServerManager();
  let firstLive = true;
  try {
    await manager.connectServer(f.config);
    const tool = (await manager.listAllTools()).tools[0];
    const [retired, admitted] = await Promise.all([
      tool.handler({}, { cwd: process.cwd(), projectName: 'retired', assertExternalMcpDispatch() {
        if (!firstLive) throw Error('first run retired');
        queueMicrotask(() => { firstLive = false; });
      } }),
      tool.handler({}, { cwd: process.cwd(), projectName: 'admitted', assertExternalMcpDispatch() {} }),
    ]);
    expect(retired.isError).toBe(true);
    expect(retired.effectOutcome).toBeUndefined();
    expect(admitted).toMatchObject({ content: 'ok' });
    expect(f.state.called).toBe(1);
  } finally { await manager.closeAll(); await f.close(); }
});


it('allows host-owned readiness calls through the same physical dispatch fence', async () => {
  const f = await fixture(), manager = new McpServerManager();
  try {
    await manager.connectServer(f.config);
    expect(await manager.callServerTool(f.config.id, 'write', {})).toMatchObject({ content: 'ok' });
    expect(f.state.called).toBe(1);
  } finally { await manager.closeAll(); await f.close(); }
});


it('blocks every competing reconnect when physical cleanup fails', async () => {
  const f = await fixture(), manager = new McpServerManager(), gate = deferred();
  try {
    await manager.connectServer(f.config);
    const connection = (manager as unknown as { connections: Map<string, { transport: { close(): Promise<void> } }> }).connections.get(f.config.id)!;
    const original = connection.transport.close.bind(connection.transport);
    connection.transport.close = async () => { await original(); await gate.promise; throw Error('reap failed'); };
    const closed = manager.closeServer(f.config.id).catch(error => error);
    const first = manager.connectServer(f.config).catch(error => error);
    const second = manager.connectServer({ ...f.config, name: 'replacement' }).catch(error => error);
    await new Promise<void>(r => setImmediate(r));
    expect(f.state.initialized).toBe(1);
    gate.resolve();
    expect(await closed).toBeInstanceOf(Error);
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await expect(manager.connectServer(f.config)).rejects.toThrow('cleanup is unproven');
    await expect(manager.closeAll()).rejects.toThrow('cleanup is unproven');
    expect(manager.getConnectionStates().get(f.config.id)?.state).toBe('error');
    expect(manager.connectedCount).toBe(0);
    expect(f.state.initialized).toBe(1);
  } finally { gate.resolve(); await manager.closeAll().catch(() => {}); await f.close(); }
});

it('ends the streamable HTTP session when closing or replacing a connection', async () => {
  const f = await fixture(), manager = new McpServerManager();
  f.state.sessions = true;
  try {
    await manager.connectServer(f.config);
    await manager.connectServer({ ...f.config, config: { changed: true } });
    expect(f.state.deleted).toEqual(['session-1']);
    await manager.closeAll();
    expect(f.state.deleted).toEqual(['session-1', 'session-2']);
  } finally { await manager.closeAll(); await f.close(); }
});

it('closes and reconnects when the session DELETE fails or never answers', async () => {
  const f = await fixture(), manager = new McpServerManager();
  f.state.sessions = true;
  f.state.deleteStatus = 500;
  try {
    await manager.connectServer(f.config);
    await manager.closeServer(f.config.id);
    f.state.deleteStatus = 'hang';
    await manager.connectServer(f.config);
    const started = Date.now();
    await manager.closeAll();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(f.state.deleted).toEqual(['session-1', 'session-2']);
    f.state.deleteStatus = 204;
    await manager.connectServer(f.config);
    expect(manager.connectedCount).toBe(1);
  } finally { f.state.deleteStatus = 204; await manager.closeAll(); await f.close(); }
});

it('retains the cleanup fence after SDK onclose has discarded its transport', async () => {
  const f = await fixture(), manager = new McpServerManager();
  try {
    await manager.connectServer(f.config);
    const connection = (manager as unknown as { connections: Map<string, { transport: { close(): Promise<void> } }> }).connections.get(f.config.id)!;
    await connection.transport.close();
    connection.transport.close = async () => { throw Error('late reap failure'); };
    await expect(manager.closeServer(f.config.id)).rejects.toThrow('cleanup is unproven');
    await expect(manager.connectServer(f.config)).rejects.toThrow('cleanup is unproven');
    expect(f.state.initialized).toBe(1);
  } finally { await manager.closeAll().catch(() => {}); await f.close(); }
});

it('allows a cold MCP startup beyond the former ten-second deadline', async () => {
  const f = await fixture(), manager = new McpServerManager();
  f.state.hold = new Promise<void>(resolve => setTimeout(resolve, 11_000));
  try {
    await manager.connectServer(f.config);
    expect(manager.connectedCount).toBe(1);
    expect((await manager.listAllTools()).tools).toHaveLength(1);
    expect(f.state.initialized).toBe(1);
  } finally { await manager.closeAll(); await f.close(); }
});
