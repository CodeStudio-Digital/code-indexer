/**
 * Cloudflare Workers AI provider definition.
 *
 * Mocks the OpenAI{,Chat}Provider adapters so we can capture the exact
 * constructor args without touching the network. The shape we care about
 * is: account_id from creds.extra is substituted into the baseURL, the
 * api key flows through, and a missing account_id throws clearly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openAIChatCalls: Array<Record<string, unknown>> = [];

vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    openAIChatCalls.push(opts);
    Object.assign(this, opts, { name: opts.name ?? 'openai' });
  }),
}));

import type { ResolvedCreds } from '@mcp/services/providers/types.js';
import { buildProviderDefinition } from '@mcp/provider-engine/build-definition.js';
import { discoverCloudflareModels } from '@mcp/provider-engine/discovery/cloudflare-models.js';
import { cloudflareSpec } from '@mcp/provider-engine/specs/openai-compat.js';

const cloudflare = buildProviderDefinition(cloudflareSpec);

beforeEach(() => {
  openAIChatCalls.length = 0;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CF_ACCOUNT_ID;
});

describe('cloudflare provider definition', () => {
  it('declares the registry-required fields', () => {
    expect(cloudflare.kind).toBe('cloudflare');
    expect(cloudflare.credKind).toBe('api-key');
    expect(cloudflare.envVars).toEqual(['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN']);
    expect(cloudflare.defaultModels.length).toBeGreaterThan(0);
    expect(cloudflare.defaultModels.every((m) => m.startsWith('@cf/'))).toBe(true);
  });

  it('is registered in the central registry', async () => {
    const { getDefinition, listCoderKinds } = await import(
      '@mcp/services/providers/registry.js'
    );
    expect(getDefinition('cloudflare')).toBeDefined();
    expect(listCoderKinds()).toContain('cloudflare');
  });
});

describe('cloudflare.createCoder', () => {
  it('substitutes account_id from creds.extra into the baseURL', () => {
    const creds: ResolvedCreds = {
      apiKey: 'cf-token',
      extra: { account_id: 'abc123' },
    };
    cloudflare.createCoder!(creds, '@cf/meta/llama-3.1-8b-instruct-fp8');
    expect(openAIChatCalls[0].baseURL).toBe(
      'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
    );
    expect(openAIChatCalls[0].apiKey).toBe('cf-token');
    expect(openAIChatCalls[0].model).toBe('@cf/meta/llama-3.1-8b-instruct-fp8');
    expect(openAIChatCalls[0].name).toBe('cloudflare');
  });

  it('falls back to CLOUDFLARE_ACCOUNT_ID env when extra.account_id is missing', () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'env-acct-999';
    cloudflare.createCoder!({ apiKey: 'cf-token' }, '@cf/meta/llama-3.1-8b-instruct-fp8');
    expect(openAIChatCalls[0].baseURL).toBe(
      'https://api.cloudflare.com/client/v4/accounts/env-acct-999/ai/v1',
    );
  });

  it('picks a sensible default model when none is supplied', () => {
    cloudflare.createCoder!(
      { apiKey: 'cf-token', extra: { account_id: 'abc123' } },
      undefined,
    );
    expect(openAIChatCalls[0].model).toBe('@cf/moonshotai/kimi-k2.7-code');
  });

  it('throws an actionable error when account_id is missing', () => {
    expect(() => cloudflare.createCoder!({ apiKey: 'cf-token' }, '@cf/meta/llama-3.1-8b-instruct-fp8')).toThrow(
      /account[_ ]id/i,
    );
  });
});

describe('discoverCloudflare', () => {
  const baseCfg = {
    id: 'cf-instance',
    name: 'CF',
    kind: 'cloudflare' as const,
    base_url: null,
    api_key: 'cf-token',
    auth_mode: 'api_key' as const,
    enabled: true,
    use_for_agent: true,
    use_for_coder: true,
    use_for_general: false,
    is_default: false,
    extra: { account_id: 'acct-disco' },
    fallback_provider_id: null,
    created_at: '',
    updated_at: '',
  };

  it('hits the catalog endpoint with the account id and bearer token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            { name: '@cf/meta/llama-3.1-8b-instruct-fp8', task: { name: 'Text Generation' } },
            { name: '@cf/baai/bge-m3', task: { name: 'Text Embeddings' } },
            { name: '@cf/black-forest-labs/flux-1-schnell', task: { name: 'Text-to-Image' } },
            { name: 'not-a-cf-model', task: { name: 'Text Generation' } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const models = await discoverCloudflareModels(cloudflareSpec, baseCfg);
      expect(calls[0].url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acct-disco/ai/models/search?per_page=200',
      );
      const auth = (calls[0].init?.headers as Record<string, string>)?.Authorization;
      expect(auth).toBe('Bearer cf-token');
      // image model and the non-@cf/ row are filtered out; chat + embedding survive
      const ids = models.map((m) => m.model_id);
      expect(ids).toContain('@cf/meta/llama-3.1-8b-instruct-fp8');
      expect(ids).toContain('@cf/baai/bge-m3');
      expect(ids).not.toContain('@cf/black-forest-labs/flux-1-schnell');
      expect(ids).not.toContain('not-a-cf-model');
      expect(models.every((m) => m.source === 'live')).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws when account_id is missing on the cfg', async () => {
    const cfg = { ...baseCfg, extra: {} };
    await expect(discoverCloudflareModels(cloudflareSpec, cfg)).rejects.toThrow(/account[_ ]id/i);
  });
});

describe('cloudflare provider — resolver wiring', () => {
  it('forwards cfg.extra through resolveCreds for api-key shapes', async () => {
    const { resolveCreds } = await import('@mcp/services/providers/shared/resolver.js');
    const cfg = {
      id: 'cf-instance',
      name: 'CF',
      kind: 'cloudflare',
      base_url: null,
      api_key: 'cf-token',
      auth_mode: 'api_key' as const,
      enabled: true,
      use_for_agent: true,
      use_for_coder: true,
      use_for_general: false,
      is_default: false,
      extra: { account_id: 'resolver-acct' },
      fallback_provider_id: null,
      created_at: '',
      updated_at: '',
    };
    const creds = await resolveCreds(cloudflare, cfg);
    expect(creds.apiKey).toBe('cf-token');
    expect(creds.extra?.account_id).toBe('resolver-acct');
  });
});
