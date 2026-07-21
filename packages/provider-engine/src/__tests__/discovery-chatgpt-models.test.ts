import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

vi.mock('@mcp/services/providers/shared/oauth.js', () => ({
  resolveChatGPTCreds: vi.fn(async () => ({
    apiKey: 'tok-abc',
    extra: { accountId: 'acct-123' },
  })),
}));

import { discoverChatgptModels } from '../discovery/chatgpt-models.js';
import { chatgptSpec } from '../specs/chatgpt.js';

// Codex `/models` payload exercising the full field mapping: visibility,
// supported_in_api, reasoning levels (string + {effort}), context fallbacks.
const API_RESPONSE = {
  models: [
    {
      slug: 'gpt-5-codex',
      display_name: 'GPT-5 Codex',
      description: 'codex model',
      context_window: 256000,
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', { effort: 'high' }],
      apply_patch_tool_type: 'freeform',
      available_in_plans: ['plus'],
      minimal_client_version: '1.0.0',
      visibility: 'list',
      supported_in_api: true,
      input_modalities: ['text'],
    },
    {
      // hidden + non-api + context fallback to max_context_window
      slug: 'gpt-internal',
      max_context_window: 128000,
      visibility: 'hidden',
      supported_in_api: false,
    },
  ],
};

const CFG = { base_url: null } as unknown as ProviderConfig;

const realFetch = globalThis.fetch;

function mockFetch200(body: unknown, etag: string | null): void {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? etag : null) },
      json: async () => body,
    }) as unknown as Response) as typeof globalThis.fetch;
}

function mockFetch304(): void {
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 304,
      headers: { get: () => null },
    }) as unknown as Response) as typeof globalThis.fetch;
}

function mockFetch500(): void {
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => 'upstream boom',
    }) as unknown as Response) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe('chatgpt-models discovery', () => {
  it('200 with models + etag header returns DiscoveryResult', async () => {
    mockFetch200(API_RESPONSE, '"v7"');
    const b = await discoverChatgptModels(chatgptSpec, CFG, null);

    expect(b.notModified).toBe(false);
    expect(b.etag).toBe('"v7"');
    expect(b.models).toHaveLength(2);
    expect(b.models[0]).toMatchObject({
      model_id: 'gpt-5-codex',
      name: 'GPT-5 Codex',
      context_window: 256000,
      source: 'live',
      default_enabled: true,
      can_reason: true,
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'high'],
      apply_patch_tool_type: 'freeform',
      visibility: 'list',
    });
    // hidden + non-api → default_enabled false, context falls back to max
    expect(b.models[1]).toMatchObject({
      model_id: 'gpt-internal',
      context_window: 128000,
      default_enabled: false,
      visibility: 'hidden',
      supported_in_api: false,
    });
  });

  it('304 Not Modified returns notModified:true + previousEtag passthrough', async () => {
    mockFetch304();
    const b = await discoverChatgptModels(chatgptSpec, CFG, '"prev"');

    expect(b).toEqual({ models: [], etag: '"prev"', notModified: true });
  });

  it('never exposes the virtual Ultra profile as a native reasoning value', async () => {
    mockFetch200({
      models: [{
        slug: 'gpt-ultra-stale-catalog',
        default_reasoning_level: 'ultra',
        supported_reasoning_levels: ['high', 'max', 'ultra'],
        visibility: 'list',
        supported_in_api: true,
      }],
    }, null);

    const result = await discoverChatgptModels(chatgptSpec, CFG, null);
    expect(result.models[0]).toMatchObject({
      can_reason: true,
      default_reasoning_level: null,
      supported_reasoning_levels: ['high', 'max'],
    });
  });

  it('!ok (HTTP 500) falls back to seed models', async () => {
    mockFetch500();
    const b = await discoverChatgptModels(chatgptSpec, CFG, null);

    expect(b.notModified).toBe(false);
    expect(b.etag).toBeNull();
    expect(b.models.length).toBeGreaterThan(0);
    expect(b.models.every((m) => m.source === 'live')).toBe(true);
  });
});
