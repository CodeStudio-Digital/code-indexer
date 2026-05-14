import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWellKnownCandidates,
  FetchDiscoveryClient,
} from '../core/mcp-client/auth/http/fetch-discovery-client.js';

describe('buildWellKnownCandidates', () => {
  it('emits path-aware then origin-rooted for URLs with a path', () => {
    expect(buildWellKnownCandidates('https://mcp.figma.com/mcp', 'oauth-protected-resource')).toEqual([
      'https://mcp.figma.com/.well-known/oauth-protected-resource/mcp',
      'https://mcp.figma.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('emits a single origin-rooted candidate for bare origin URLs', () => {
    expect(buildWellKnownCandidates('https://api.figma.com', 'oauth-authorization-server')).toEqual([
      'https://api.figma.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('treats trailing-slash origin the same as bare origin', () => {
    expect(buildWellKnownCandidates('https://api.figma.com/', 'oauth-authorization-server')).toEqual([
      'https://api.figma.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('strips trailing slashes from the path before composing candidates', () => {
    expect(buildWellKnownCandidates('https://example.com/tenant/abc/', 'oauth-authorization-server')).toEqual([
      'https://example.com/.well-known/oauth-authorization-server/tenant/abc',
      'https://example.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('passes through URLs that already contain a well-known segment', () => {
    const url = 'https://mcp.figma.com/.well-known/oauth-protected-resource';
    expect(buildWellKnownCandidates(url, 'oauth-protected-resource')).toEqual([url]);
  });

  it('falls back to legacy concatenation when input is not a parseable URL', () => {
    expect(buildWellKnownCandidates('not a url', 'oauth-protected-resource')).toEqual([
      'not a url/.well-known/oauth-protected-resource',
    ]);
  });
});

describe('FetchDiscoveryClient.fetchProtectedResourceMetadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the body of the path-aware candidate when it succeeds first', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          resource: 'https://mcp.figma.com/mcp',
          authorization_servers: ['https://api.figma.com'],
          scopes_supported: ['mcp:connect'],
          bearer_methods_supported: ['header'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new FetchDiscoveryClient();
    const out = await client.fetchProtectedResourceMetadata('https://mcp.figma.com/mcp');

    expect(calls).toEqual(['https://mcp.figma.com/.well-known/oauth-protected-resource/mcp']);
    expect(out.authorizationServers).toEqual(['https://api.figma.com']);
    expect(out.scopesSupported).toEqual(['mcp:connect']);
  });

  it('falls back to the origin-rooted candidate when path-aware returns 404', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (url.endsWith('/oauth-protected-resource/mcp')) {
        return new Response(JSON.stringify({ status: 404, err: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          resource: 'https://mcp.figma.com/mcp',
          authorization_servers: ['https://api.figma.com'],
          scopes_supported: ['mcp:connect'],
          bearer_methods_supported: ['header'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new FetchDiscoveryClient();
    const out = await client.fetchProtectedResourceMetadata('https://mcp.figma.com/mcp');

    expect(calls).toEqual([
      'https://mcp.figma.com/.well-known/oauth-protected-resource/mcp',
      'https://mcp.figma.com/.well-known/oauth-protected-resource',
    ]);
    expect(out.authorizationServers).toEqual(['https://api.figma.com']);
  });

  it('throws an error listing every attempt when all candidates fail', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      new Response(`missed ${url}`, { status: 404 }),
    );

    const client = new FetchDiscoveryClient();
    await expect(
      client.fetchProtectedResourceMetadata('https://mcp.figma.com/mcp'),
    ).rejects.toThrow(/oauth-protected-resource\/mcp.*HTTP 404.*\|.*oauth-protected-resource.*HTTP 404/s);
  });
});

describe('FetchDiscoveryClient.fetchAuthorizationServerMetadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries the origin-rooted well-known for a bare-origin issuer', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          issuer: 'https://api.figma.com',
          authorization_endpoint: 'https://www.figma.com/oauth/mcp',
          token_endpoint: 'https://api.figma.com/v1/oauth/token',
          registration_endpoint: 'https://api.figma.com/v1/oauth/mcp/register',
          scopes_supported: ['mcp:connect'],
          code_challenge_methods_supported: ['S256'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new FetchDiscoveryClient();
    const out = await client.fetchAuthorizationServerMetadata('https://api.figma.com');

    expect(calls).toEqual(['https://api.figma.com/.well-known/oauth-authorization-server']);
    expect(out.tokenEndpoint).toBe('https://api.figma.com/v1/oauth/token');
    expect(out.registrationEndpoint).toBe('https://api.figma.com/v1/oauth/mcp/register');
    expect(out.codeChallengeMethodsSupported).toEqual(['S256']);
  });
});
