/**
 * Equivalence: the declarative OpenRouter discovery (engine) produces an
 * IDENTICAL `UpsertModelInput[]` to the hand-written admin discoverX.
 *
 * The sample API response is copied verbatim from
 * `src/__tests__/openrouter-provider.test.ts` (the `discoverOpenrouter` test)
 * so the rich field mapping — context_length / architecture modalities /
 * top_provider limits / supported_parameters → can_reason /
 * supported_reasoning_levels / visibility / the text-output filter — is proven
 * identical on both paths.
 */
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

describe('openrouter-models discovery equivalence: engine(spec) == admin discoverX', () => {
  it('maps the rich catalog identically to the admin discoverOpenrouter', async () => {
    globalThis.fetch = vi.fn(async () => sampleResponse()) as unknown as typeof fetch;
    const { discoverOpenrouter } = await import(
      '@apps/http-api/admin/model-discovery/openrouter.js'
    );

    const a = await discoverOpenrouter(baseCfg);
    const b = await discoverOpenrouterModels(openrouterSpec, baseCfg);

    // Field-by-field rich-metadata parity is proven by structural equality.
    expect(b).toEqual(a);

    // Sanity: the text-output filter dropped the image-only model, and the
    // surviving row carries the full rich payload.
    expect(a).toHaveLength(1);
    expect(b[0]).toMatchObject({
      model_id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      display_name: 'Claude Sonnet 4.5',
      description: 'coding model',
      context_window: 200000,
      default_max_tokens: 64000,
      can_reason: true,
      supports_attachments: true,
      supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
      supported_in_api: true,
      visibility: 'list',
      input_modalities: ['text', 'image'],
      source: 'live',
    });
  });

  it('calls the same OpenRouter endpoint with the same Authorization header', async () => {
    const adminCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      adminCalls.push({ url: String(url), init });
      return sampleResponse();
    }) as unknown as typeof fetch;
    const { discoverOpenrouter } = await import(
      '@apps/http-api/admin/model-discovery/openrouter.js'
    );
    await discoverOpenrouter(baseCfg);

    const engineCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      engineCalls.push({ url: String(url), init });
      return sampleResponse();
    }) as unknown as typeof fetch;
    await discoverOpenrouterModels(openrouterSpec, baseCfg);

    expect(engineCalls[0].url).toBe('https://openrouter.ai/api/v1/models?output_modalities=text');
    expect(engineCalls[0].url).toBe(adminCalls[0].url);
    expect((engineCalls[0].init?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer or-test',
    );
    expect((engineCalls[0].init?.headers as Record<string, string>)?.Authorization).toBe(
      (adminCalls[0].init?.headers as Record<string, string>)?.Authorization,
    );
  });

  it('throws the same error on non-2xx (both paths)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;
    const { discoverOpenrouter } = await import(
      '@apps/http-api/admin/model-discovery/openrouter.js'
    );
    await expect(discoverOpenrouter(baseCfg)).rejects.toThrow(/HTTP 403/);
    await expect(discoverOpenrouterModels(openrouterSpec, baseCfg)).rejects.toThrow(/HTTP 403/);
  });
});
