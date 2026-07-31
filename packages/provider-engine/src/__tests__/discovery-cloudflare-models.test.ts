import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { discoverCloudflareModels } from '../discovery/cloudflare-models.js';
import { cloudflareSpec } from '../specs/openai-compat.js';

const SAMPLE_RESPONSE = {
  success: true,
  result: [
    {
      name: '@cf/moonshotai/kimi-k2.7-code',
      display_name: 'Kimi K2.7 Code',
      description: 'Agentic coding model',
      task: { name: 'Text Generation' },
      properties: [
        { property_id: 'context_window', value: '262,144' },
        { property_id: 'reasoning', value: true },
        { property_id: 'vision', value: true },
      ],
    },
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

describe('cloudflare-models discovery', () => {
  it('keeps text-generation/text-embedding @cf models and drops images/non-@cf rows', async () => {
    globalThis.fetch = mockFetch();
    const b = await discoverCloudflareModels(cloudflareSpec, cfg);

    expect(b.map((m) => m.model_id)).toEqual([
      '@cf/moonshotai/kimi-k2.7-code',
      '@cf/baai/bge-m3',
    ]);
    expect(b[0]).toMatchObject({
      name: 'Kimi K2.7 Code',
      display_name: 'Kimi K2.7 Code',
      description: 'Agentic coding model',
      context_window: 262_144,
      can_reason: true,
      supports_attachments: true,
      input_modalities: ['text', 'image'],
      visibility: 'list',
      supported_in_api: true,
      source: 'live',
    });
  });
});
