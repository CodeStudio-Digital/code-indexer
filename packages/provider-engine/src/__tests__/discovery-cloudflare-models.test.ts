/**
 * Equivalence: the engine's spec-driven `discoverCloudflareModels(spec, cfg)`
 * returns the SAME UpsertModelInput[] as the hand-written admin
 * `discoverCloudflare(cfg)`. We mock globalThis.fetch with a representative
 * Cloudflare catalog response (copied from src/__tests__/cloudflare-provider.test.ts:
 * a chat model, an embedding model, an image model and a non-@cf/ row) and
 * deepEqual the two outputs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { discoverCloudflareModels } from '../discovery/cloudflare-models.js';
import { cloudflareSpec } from '../specs/openai-compat.js';

const SAMPLE_RESPONSE = {
  success: true,
  result: [
    { name: '@cf/meta/llama-3.1-8b-instruct-fp8', task: { name: 'Text Generation' } },
    { name: '@cf/baai/bge-m3', task: { name: 'Text Embeddings' } },
    { name: '@cf/black-forest-labs/flux-1-schnell', task: { name: 'Text-to-Image' } },
    { name: 'not-a-cf-model', task: { name: 'Text Generation' } },
  ],
};

const cfg: ProviderConfig = {
  id: 'cf-instance',
  name: 'CF',
  kind: 'cloudflare',
  base_url: null,
  api_key: 'cf',
  auth_mode: 'api_key',
  enabled: true,
  use_for_agent: true,
  use_for_coder: true,
  use_for_general: false,
  is_default: false,
  extra: { account_id: 'acct' },
  fallback_provider_id: null,
  created_at: '',
  updated_at: '',
};

function mockFetch(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('cloudflare-models discovery equivalence: engine(spec) == admin discoverX', () => {
  it('returns an identical UpsertModelInput[]', async () => {
    // Admin discoverX
    globalThis.fetch = mockFetch();
    const { discoverCloudflare } = await import(
      '@apps/http-api/admin/model-discovery/cloudflare.js'
    );
    const a = await discoverCloudflare(cfg);

    // Engine spec-driven
    globalThis.fetch = mockFetch();
    const b = await discoverCloudflareModels(cloudflareSpec, cfg);

    expect(b).toEqual(a);
  });
});
