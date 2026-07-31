import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { discoverOpenrouterModels } from '../discovery/openrouter-models.js';
import { openrouterSpec } from '../specs/openai-compat.js';

const baseCfg: ProviderConfig = {
  id: 'openrouter-instance',
  name: 'OpenRouter',
  kind: 'openrouter' as const,
  base_url: null,
  api_key: 'or-test',
  auth_mode: 'api_key' as const,
  enabled: true,
  use_for_agent: true,
  use_for_coder: true,
  use_for_general: false,
  is_default: false,
  extra: {},
  fallback_provider_id: null,
  created_at: '',
  updated_at: '',
} as unknown as ProviderConfig;

/** Realistic OpenRouter /models payload (copied from openrouter-provider.test.ts). */
function sampleResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          description: 'coding model',
          context_length: 200000,
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
          top_provider: {
            context_length: 180000,
            max_completion_tokens: 64000,
          },
          supported_parameters: ['tools', 'reasoning', 'temperature'],
          reasoning: {
            supported_efforts: ['low', 'high', 'max'],
            default_effort: 'high',
            mandatory: true,
          },
        },
        {
          id: 'black-forest-labs/flux',
          name: 'Flux',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['image'],
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('openrouter-models discovery', () => {
  it('maps the rich catalog and filters image-only models', async () => {
    globalThis.fetch = vi.fn(async () => sampleResponse()) as unknown as typeof fetch;

    const b = await discoverOpenrouterModels(openrouterSpec, baseCfg);

    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      model_id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      display_name: 'Claude Sonnet 4.5',
      description: 'coding model',
      context_window: 200000,
      default_max_tokens: 64000,
      can_reason: true,
      supports_attachments: true,
      supported_reasoning_levels: ['low', 'high', 'max'],
      default_reasoning_level: 'high',
      supported_in_api: true,
      visibility: 'list',
      input_modalities: ['text', 'image'],
      source: 'live',
    });
  });

  it('calls the OpenRouter endpoint with the Authorization header', async () => {
    const engineCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      engineCalls.push({ url: String(url), init });
      return sampleResponse();
    }) as unknown as typeof fetch;
    await discoverOpenrouterModels(openrouterSpec, baseCfg);

    expect(engineCalls[0].url).toBe('https://openrouter.ai/api/v1/models?output_modalities=text');
    expect((engineCalls[0].init?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer or-test',
    );
  });

  it('throws on non-2xx', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(discoverOpenrouterModels(openrouterSpec, baseCfg)).rejects.toThrow(/HTTP 403/);
  });
});
