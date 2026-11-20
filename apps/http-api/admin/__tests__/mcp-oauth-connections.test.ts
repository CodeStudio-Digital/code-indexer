import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, describe, expect, it } from 'vitest';
import { composeMcpClientAuth } from '@mcp/services/mcp-client/auth/composition.js';
import { mcpServers015 } from '@mcp/store/migrations/015_mcp_servers.js';
import { mcpClientOauth030 } from '@mcp/store/migrations/030_mcp_client_oauth.js';
import { mcpOAuthResource274 } from '@mcp/store/migrations/274_mcp_oauth_resource.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { McpExternalPool, setGlobalMcpExternalPool } from '../../sse/McpExternalPool.js';
import { createMcpServersOauthRouter } from '../mcp-servers-oauth.routes.js';
import { mcpServersRouter } from '../mcp-servers.routes.js';

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { setGlobalMcpExternalPool(null); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(transport: 'streamable_http' | 'sse' = 'streamable_http') {
  const folder = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
  const dbPath = join(folder, 'index.db');
  const db = new Database(dbPath);
  mcpServers015.up(db); mcpClientOauth030.up(db); mcpOAuthResource274.up(db);
  const store = new McpServerStore(db);
  const state = { token: 'test-access-1', refreshes: 0, refreshError: 0, calls: 0, unauthorized: 0,
    lists: 0, initializes: 0, failList: false, resource: '', clientAuth: '', grantTypes: [] as string[] };
  const events = new Set<ServerResponse>();
  let endpoint = '';
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const url = new URL(req.url!, endpoint);
      const json = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: endpoint + '/mcp', authorization_servers: [endpoint], scopes_supported: ['mcp:use'] });
      if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: endpoint,
        authorization_endpoint: endpoint + '/authorize', token_endpoint: endpoint + '/token', registration_endpoint: endpoint + '/register',
        scopes_supported: ['mcp:use'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      if (url.pathname === '/register') { state.grantTypes = JSON.parse(raw).grant_types; return json({ client_id: 'fixture-client' }); }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(raw); state.resource = form.get('resource') ?? ''; state.clientAuth = req.headers.authorization ?? '';
        if (form.get('grant_type') === 'refresh_token') {
          state.refreshes++;
          if (state.refreshError) return json({ error: state.refreshError === 400 ? 'invalid_grant' : 'temporarily_unavailable' }, state.refreshError);
          state.token = `test-access-${state.refreshes + 1}`;
        }
        return json({ access_token: state.token, refresh_token: `refresh-${state.refreshes}`, expires_in: 3600, token_type: 'Bearer', scope: 'mcp:use' });
      }
      if (req.headers.authorization !== `Bearer ${state.token}`) { state.unauthorized++; return json({ error: 'unauthorized' }, 401); }
      if (req.method === 'GET' && transport === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n'); events.add(res); res.on('close', () => events.delete(res)); return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const request = JSON.parse(raw);
      if (request.id === undefined) { res.writeHead(202).end(); return; }
      let result: unknown = {};
      if (request.method === 'initialize') {
        state.initializes++; result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } };
      } else if (request.method === 'tools/list') {
        state.lists++;
        result = { tools: [{ name: request.params?.cursor ? 'inspect' : 'read', inputSchema: { type: 'object' } }],
          ...(request.params?.cursor ? {} : { nextCursor: 'second' }) };
      } else if (request.method === 'tools/call') { state.calls++; result = { content: [{ type: 'text', text: 'fixture result' }] }; }
      const response = { jsonrpc: '2.0', id: request.id, ...(state.failList && request.method === 'tools/list'
        ? { error: { code: -32603, message: 'catalogue offline' } } : { result }) };
      if (transport === 'sse') { res.writeHead(202).end(); for (const e of events) e.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`); }
      else json(response);
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  store.upsertServer({ id: 'fixture', name: 'Fixture', transport, url: endpoint + '/mcp', auth_type: 'oauth2', enabled: true });
  const bundle = composeMcpClientAuth(dbPath);
  const app = new HttpRouter().route('/api/admin', createMcpServersOauthRouter(bundle, () => 'http://localhost:7333'))
    .route('/api/admin', mcpServersRouter({ dbPath, bearerResolver: bundle.resolveBearer }));
  const pool = new McpExternalPool({ dbPath, bearerResolver: bundle.resolveBearer });
  setGlobalMcpExternalPool(pool);
  cleanup.push(async () => { await pool.shutdown(); bundle.close(); db.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(folder, { recursive: true, force: true }); });
  const route = '/api/admin/mcp-servers/fixture';
  const post = (path: string, body?: unknown) => app.request(route + path, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const register = () => post('/oauth/register', { resource_url: endpoint + '/mcp' });
  const authorize = async () => {
    expect((await register()).status).toBe(201);
    const flow = await (await post('/oauth/authorize')).json();
    expect(new URL(flow.authorization_url).searchParams.get('resource')).toBe(endpoint + '/mcp');
    const callback = await app.request(route + `/oauth/callback?code=fixture-code&state=${flow.state}`);
    expect(await callback.text()).toContain('Authorized');
    return flow;
  };
  return { db, store, bundle, app, pool, state, route, post, register, authorize, endpoint };
}

describe('MCP OAuth through real HTTP, SDK, SQLite and runtime catalogue', () => {
  it.each(['streamable_http', 'sse'] as const)('%s: consent -> test -> available tools, refresh, revoke', async transport => {
    const f = await fixture(transport);
    const flow = await f.authorize();
    const authStatus = await (await f.app.request(f.route + `/oauth/status?state=${flow.state}`)).json();
    expect(authStatus).toMatchObject({ authenticated: true, connected: false, attempt: { status: 'authenticated', state: flow.state } });
    expect(f.state.resource).toBe(f.endpoint + '/mcp');
    expect(await (await f.post('/test')).json()).toMatchObject({ ok: true, toolCount: 2 });
    expect(f.pool.getSnapshot().tools.map(t => t.name)).toEqual(['ext_fixture__inspect', 'ext_fixture__read']);
    f.db.prepare('UPDATE mcp_oauth_tokens SET access_expires_at = 0').run();
    const results = await Promise.all([f.bundle.resolveBearer.execute('fixture'), f.bundle.resolveBearer.execute('fixture')]);
    expect(results.every(r => r.ok)).toBe(true); expect(f.state.refreshes).toBe(1);
    expect((await f.pool.callTool('fixture', 'read', {})).ok).toBe(true);
    expect(f.state.calls).toBe(1); expect(f.state.unauthorized).toBe(0);
    await f.app.request(f.route + '/oauth', { method: 'DELETE' });
    expect(f.bundle.tokensReaderRepo.findByServerId('fixture')).toBeNull();
    expect(f.pool.getSnapshot().tools).toHaveLength(0);
    expect((await f.pool.callTool('fixture', 'read', {})).ok).toBe(false); expect(f.state.calls).toBe(1);
  });

  it.each([429, 500, 503])('keeps credentials after refresh HTTP %i and retries successfully', async code => {
    const f = await fixture(); await f.authorize();
    f.db.prepare('UPDATE mcp_oauth_tokens SET access_expires_at = 0').run(); f.state.refreshError = code;
    expect((await f.bundle.resolveBearer.execute('fixture')).ok).toBe(false);
    expect(f.bundle.tokensReaderRepo.findByServerId('fixture')).not.toBeNull();
    f.state.refreshError = 0; expect((await f.bundle.resolveBearer.execute('fixture')).ok).toBe(true);
  });

  it('rejects invalid_grant, unrelated callbacks, replay and cancelled attempts', async () => {
    const f = await fixture(); const flow = await f.authorize();
    expect(await (await f.app.request(f.route + `/oauth/callback?code=again&state=${flow.state}`)).text()).toContain('invalid_state');
    const next = await (await f.post('/oauth/authorize')).json();
    expect(await (await f.app.request(`/api/admin/mcp-servers/other/oauth/callback?code=x&state=${next.state}`)).text()).toContain('invalid_state');
    await f.app.request(f.route + `/oauth/authorize?state=${next.state}`, { method: 'DELETE' });
    expect(await (await f.app.request(f.route + `/oauth/callback?code=x&state=${next.state}`)).text()).toContain('invalid_state');
    f.db.prepare('UPDATE mcp_oauth_tokens SET access_expires_at = 0').run(); f.state.refreshError = 400;
    expect((await f.bundle.resolveBearer.execute('fixture')).ok).toBe(false);
    expect(f.bundle.tokensReaderRepo.findByServerId('fixture')).toBeNull();
  });

  it('reports consent denial immediately without accepting a token refresh as consent', async () => {
    const f = await fixture(); await f.authorize();
    const flow = await (await f.post('/oauth/authorize')).json();
    await f.bundle.refreshAccess.execute({ serverId: 'fixture' });
    expect((await (await f.app.request(f.route + `/oauth/status?state=${flow.state}`)).json()).attempt.status).toBe('pending');
    await f.app.request(f.route + `/oauth/callback?error=access_denied&state=${flow.state}`);
    expect((await (await f.app.request(f.route + `/oauth/status?state=${flow.state}`)).json()).attempt).toMatchObject({ status: 'error', error: 'access_denied' });
  });

  it('manual registration round-trips metadata and uses HTTP Basic when advertised', async () => {
    const f = await fixture();
    const meta = await (await f.post('/oauth/discover', { resource_url: f.endpoint + '/mcp' })).json();
    expect(meta.resource.scopes_supported).toEqual(['mcp:use']);
    meta.as.token_endpoint_auth_methods_supported = ['client_secret_basic'];
    expect((await f.post('/oauth/register', { as: meta.as, resource_url: meta.resource.resource, client_id: 'manual', client_secret: 'fixture-secret' })).status).toBe(201);
    const flow = await (await f.post('/oauth/authorize')).json();
    await f.app.request(f.route + `/oauth/callback?code=fixture-code&state=${flow.state}`);
    expect(f.state.clientAuth).toBe('Basic ' + Buffer.from('manual:fixture-secret').toString('base64'));
    expect(await (await f.post('/test')).json()).toMatchObject({ ok: true, toolCount: 2 });
  });

  it('does not report success when tools/list failed after initialize', async () => {
    const f = await fixture(); await f.authorize(); f.state.failList = true;
    expect(await (await f.post('/test')).json()).toMatchObject({ ok: false, error: expect.stringContaining('catalogue offline') });
    expect(f.pool.getSnapshot().tools).toHaveLength(0);
  });

  it('keeps admitted calls and the transport after a server registers and tests the same settings again', async () => {
    const f = await fixture();
    await f.authorize();
    const previousTimestamp = '2026-01-01T00:00:00.000Z';
    f.db.prepare('UPDATE mcp_server_configs SET updated_at = ? WHERE id = ?').run(previousTimestamp, 'fixture');
    await f.pool.boot();
    const admitted = (await f.pool.listAllTools()).tools.find(tool => tool.name === 'ext_fixture__read')!;
    const initializations = f.state.initializes;
    const revision = f.pool.getSnapshot().tools.find(tool => tool.toolName === 'read')!.catalogueRevision;

    const saved = await f.app.request('/api/admin/mcp-servers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'fixture', name: 'Fixture', transport: 'streamable_http',
        url: f.endpoint + '/mcp', auth_type: 'oauth2', enabled: true }),
    });
    expect(saved.status).toBe(201);
    expect((await saved.json()).updated_at).not.toBe(previousTimestamp);
    expect(await (await f.post('/test')).json()).toMatchObject({ ok: true, toolCount: 2 });
    expect(f.state.initializes).toBe(initializations);
    expect(f.pool.getSnapshot().tools.find(tool => tool.toolName === 'read')!.catalogueRevision).toBe(revision);
    expect(await admitted.handler({}, {} as import('@mcp/code-agent/core/tool.js').ToolContext))
      .toMatchObject({ content: 'fixture result' });
  });

  it('updates a single server without replacing unrelated connections or revisions', async () => {
    const f = await fixture(); await f.authorize();
    f.store.upsertServer({ id: 'other', name: 'Other', transport: 'streamable_http', url: f.endpoint + '/mcp', auth_type: 'bearer', auth_token: f.state.token });
    await f.pool.boot();
    const previous = f.pool.getSnapshot().tools.find(t => t.serverId === 'other')!.catalogueRevision;
    const starts = f.state.initializes;
    await f.pool.refreshServer('fixture');
    expect(f.state.initializes - starts).toBe(1);
    expect(f.pool.getSnapshot().tools.find(t => t.serverId === 'other')!.catalogueRevision).toBe(previous);
  });

  it('OAuth without a resolver fails before sending an anonymous connection', async () => {
    const f = await fixture(); const manager = new McpServerManager();
    await expect(manager.connectServer(f.store.getServer('fixture')!)).rejects.toThrow('OAuth is not configured');
    await manager.closeAll(); expect(f.state.unauthorized).toBe(0);
  });

  it('recovers a rejected bearer on the next call without replaying the rejected call', async () => {
    const f = await fixture(); await f.authorize(); await f.pool.boot();
    f.state.token = 'server-invalidated-the-old-token';
    expect((await f.pool.callTool('fixture', 'read', {})).ok).toBe(false);
    expect(f.state.calls).toBe(0); expect(f.state.unauthorized).toBe(1);
    expect((await f.pool.callTool('fixture', 'read', {})).ok).toBe(true);
    expect(f.state.refreshes).toBe(1); expect(f.state.calls).toBe(1);
  });

  it('an auth refresh failure before dispatch is not an ambiguous tool outcome', async () => {
    const f = await fixture(); await f.authorize(); await f.pool.boot();
    f.db.prepare('UPDATE mcp_oauth_tokens SET access_expires_at = 0').run(); f.state.refreshError = 503;
    const result = await f.pool.callTool('fixture', 'read', {});
    expect(result.ok).toBe(false); expect(result.result.effectOutcome).not.toBe('unknown');
    expect(f.state.calls).toBe(0); expect(f.state.unauthorized).toBe(0);
  });

  it('keeps a still-valid access token usable when the provider does not issue refresh tokens', async () => {
    const f = await fixture(); await f.authorize();
    f.db.prepare('UPDATE mcp_oauth_tokens SET refresh_raw = NULL, access_expires_at = ?').run(Date.now() + 30_000);
    expect((await f.bundle.resolveBearer.execute('fixture')).ok).toBe(true);
    expect(f.state.refreshes).toBe(0);
  });
});
