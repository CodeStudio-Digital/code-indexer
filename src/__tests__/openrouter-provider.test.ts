/**
 * OpenRouter provider definition and live model discovery.
 *
 * OpenRouter is OpenAI-compatible for chat/completions, but its model catalog
 * carries richer metadata than the basic OpenAI `/models` shape. These tests
 * keep both sides wired: adapter construction and catalog persistence fields.
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
import { discoverOpenrouterModels } from '@mcp/provider-engine/discovery/openrouter-models.js';
import { openrouterSpec } from '@mcp/provider-engine/specs/openai-compat.js';

const openrouter = buildProviderDefinition(openrouterSpec);

beforeEach(() => {
  openAIChatCalls.length = 0;
  delete process.env.OPENROUTER_HTTP_REFERER;
  delete process.env.OPENROUTER_SITE_URL;
  delete process.env.OPENROUTER_APP_TITLE;
});

describe('openrouter provider definition', () => {
  it('declares the registry-required fields', () => {
    expect(openrouter.kind).toBe('openrouter');
    expect(openrouter.credKind).toBe('api-key');
    expect(openrouter.envVars).toEqual(['OPENROUTER_API_KEY']);
    expect(openrouter.defaultBaseURL).toBe('https://openrouter.ai/api/v1');
    expect(openrouter.defaultModels).toContain('~openai/gpt-latest');
  });

  it('is registered as coder capable', async () => {
    const { getDefinition, listCoderKinds } = await import(
      '@mcp/services/providers/registry.js'
    );
    expect(getDefinition('openrouter')).toBeDefined();
    expect(listCoderKinds()).toContain('openrouter');
  });
});

describe('openrouter.createCoder', () => {
  it('sends the MegaBrain attribution headers by default', () => {
    openrouter.createCoder!({ apiKey: 'or-test' }, 'openai/gpt-4o-mini');
    expect(openAIChatCalls[0].defaultHeaders).toEqual({
      'HTTP-Referer': 'https://codestudio.digital',
      'X-OpenRouter-Title': 'MegaBrain',
    });
  });

  it('uses the OpenRouter base URL and forwards attribution headers', () => {
    const creds: ResolvedCreds = {
      apiKey: 'or-test',
      extra: {
        http_referer: 'https://example.com',
        app_title: 'MCP Test',
      },
    };
    openrouter.createCoder!(creds, 'anthropic/claude-sonnet-4.5');
    expect(openAIChatCalls[0].name).toBe('openrouter');
    expect(openAIChatCalls[0].apiKey).toBe('or-test');
    expect(openAIChatCalls[0].baseURL).toBe('https://openrouter.ai/api/v1');
    expect(openAIChatCalls[0].model).toBe('anthropic/claude-sonnet-4.5');
    expect(openAIChatCalls[0].vendor).toBe('openrouter');
    expect(openAIChatCalls[0].defaultHeaders).toEqual({
      'HTTP-Referer': 'https://example.com',
      'X-OpenRouter-Title': 'MCP Test',
    });
  });

  it('picks the documented latest alias as the default model', () => {
    openrouter.createCoder!({ apiKey: 'or-test' }, undefined);
    expect(openAIChatCalls[0].model).toBe('~openai/gpt-latest');
  });
});

describe('discoverOpenrouter', () => {
  const baseCfg = {
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
  };

  it('persists rich metadata from /models and filters non-text outputs', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
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
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const models = await discoverOpenrouterModels(openrouterSpec, baseCfg);
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models?output_modalities=text');
      expect((calls[0].init?.headers as Record<string, string>)?.Authorization).toBe(
        'Bearer or-test',
      );
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        model_id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        display_name: 'Claude Sonnet 4.5',
        description: 'coding model',
        context_window: 200000,
        default_max_tokens: 64000,
        can_reason: true,
        supports_attachments: true,
        supported_reasoning_levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        input_modalities: ['text', 'image'],
        source: 'live',
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws on non-2xx responses', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(discoverOpenrouterModels(openrouterSpec, baseCfg)).rejects.toThrow(/HTTP 403/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
