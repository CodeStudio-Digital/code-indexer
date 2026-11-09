import { afterEach, expect, it, vi } from 'vitest';
import { FetchDiscoveryClient } from '../fetch-discovery-client.js';
import { FetchTokenExchangeClient } from '../fetch-token-exchange-client.js';

afterEach(() => vi.unstubAllGlobals());
it('falls back to path-aware OpenID metadata and rejects mismatched issuers', async () => {
  const fetcher = vi.fn(async (url: string) => url.includes('openid-configuration')
    ? Response.json({ issuer: 'https://auth.example/tenant', authorization_endpoint: 'https://auth.example/consent', token_endpoint: 'https://auth.example/token' })
    : new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await new FetchDiscoveryClient().fetchAuthorizationServerMetadata('https://auth.example/tenant')).toMatchObject({ issuer: 'https://auth.example/tenant' });
  expect(fetcher.mock.calls.map(c => c[0])).toContain('https://auth.example/.well-known/openid-configuration/tenant');
  await expect(new FetchDiscoveryClient().fetchAuthorizationServerMetadata('https://auth.example/wrong')).rejects.toThrow('issuer mismatch');
});
it('discovers a resource through a WWW-Authenticate challenge', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://mcp.example/rpc') return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/metadata"' } });
    if (url === 'https://mcp.example/metadata') return Response.json({ resource: 'https://mcp.example/rpc', authorization_servers: ['https://auth.example'] });
    return new Response('Not found', { status: 404 });
  }));
  expect(await new FetchDiscoveryClient().fetchProtectedResourceMetadata('https://mcp.example/rpc')).toMatchObject({ authorizationServers: ['https://auth.example'] });
});
it('skips invalid HTML discovery responses and sets a finite request deadline', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return url.endsWith('/rpc') ? new Response('<html>') : Response.json({ resource: 'https://mcp.example/rpc', authorization_servers: ['https://auth.example'] });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await new FetchDiscoveryClient().fetchProtectedResourceMetadata('https://mcp.example/rpc')).toMatchObject({ resource: 'https://mcp.example/rpc' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not follow credential-bearing token redirects and accepts string expires_in', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new URLSearchParams(String(init.body)).get('resource')).toBe('https://mcp.example');
    return Response.json({ access_token: 'synthetic', expires_in: '120', token_type: 'Bearer' });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await new FetchTokenExchangeClient().refresh({ tokenEndpoint: 'https://auth.example/token', clientId: 'fixture', clientSecret: null,
    refreshToken: 'synthetic-refresh', resourceUrl: 'https://mcp.example' })).toMatchObject({ expiresInSec: 120 });
});
