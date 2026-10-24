import { expect, it, vi } from 'vitest';
import { createMcpHttpApp } from '../http/mcp-http-transport.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';

vi.mock('../context.js', () => ({ buildContext: () => ({ db: { listProjects: () => [] } }) }));
vi.mock('../tools/index.js', () => {
  const tool = { name: 'identity', description: 'Return request identity', tier: 'bootstrap', scope: 'mcp:read',
    annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} },
    handler: async (_args: unknown, _ctx: unknown, auth: AuthContext) => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return { text: auth.principal, structuredContent: { principal: auth.principal } };
    } };
  return { allTools: [tool], buildToolRegistry: () => new Map([[tool.name, tool]]) };
});
vi.mock('../resources/index.js', () => ({ allResources: [], collectListedResources: () => [],
  readResource: () => null, DEFAULT_RESOURCE_SCOPE: 'mcp:read' }));

it('accepts initialize, notification, repeated lists and concurrent calls with fresh stateless transports', async () => {
  const app = createMcpHttpApp({ mcp: { http: { stateful: false } } } as IndexerConfig, {
    resolveAuthContext: c => ({ principal: c.req.header('x-principal') ?? 'local' }) as AuthContext,
  });
  const send = (method: string, id?: number, params?: unknown, principal = 'local') => app.request('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26', 'x-principal': principal },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(id === undefined ? {} : { id }), params }),
  });
  const initialized = await send('initialize', 1, { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'test', version: '1' } });
  expect(initialized.status).toBe(200);
  expect((await initialized.json()).result.serverInfo.name).toBeTruthy();
  expect((await send('notifications/initialized')).status).toBe(202);
  for (let id = 2; id <= 3; id++) {
    const list = await send('tools/list', id, {});
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools[0].name).toBe('identity');
  }
  const replies = await Promise.all(['alice', 'bob'].map(async (principal, index) => {
    const response = await send('tools/call', 4 + index, { name: 'identity', arguments: {} }, principal);
    expect(response.status).toBe(200);
    return (await response.json()).result.structuredContent.principal;
  }));
  expect(replies).toEqual(['alice', 'bob']);
  const get = await app.request('http://localhost/', { headers: { accept: 'text/event-stream' } });
  expect(get.status).toBe(405);
});
