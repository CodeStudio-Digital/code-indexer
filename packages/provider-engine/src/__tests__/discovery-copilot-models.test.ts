import { describe, it, expect, afterEach } from 'vitest';
import type {
  ProviderConfig,
  ProviderStore,
} from '@mcp/store/provider-store.js';

import { discoverCopilotModels, mapCopilotModel } from '../discovery/copilot-models.js';
import { copilotSpec } from '../specs/copilot.js';

// The OAuth helpers only touch `store.getOAuth`. We mock the network at
// `globalThis.fetch` and supply a fake store whose token is non-expired, so
// `refreshIfExpired` returns the stored access_token without any exchange.
const CFG = { id: 'copilot', api_key: 'mirror-key', base_url: null } as unknown as ProviderConfig;

// Non-expired token (expires well beyond the 60s freshness window) so
// `refreshIfExpired` short-circuits to `tok.access_token`. No `endpoints.api` in
// `extra`, so `resolveCopilotApiBase` falls back to the public default.
function fakeStore(): ProviderStore {
  return {
    getOAuth: () => ({
      provider_id: 'copilot',
      access_token: 'live-token',
      refresh_token: 'gh-pat',
      expires_at: Date.now() + 3_600_000,
      scope: null,
      extra: {},
    }),
  } as unknown as ProviderStore;
}

// Representative current /models payload with Copilot capability limits.
const API_RESPONSE = {
  data: [
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      model_picker_enabled: true,
      capabilities: {
        limits: {
          max_context_window_tokens: 1_050_000,
          max_output_tokens: 128_000,
        },
        supports: { vision: true, reasoning: true },
      },
    },
    { id: 'mystery-model', model_picker_enabled: false },
  ],
};

const realFetch = globalThis.fetch;

function mockFetchOk(body: unknown): void {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
    }) as unknown as Response) as typeof globalThis.fetch;
}

function mockFetchErr(status: number, text = 'nope'): void {
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status,
      text: async () => text,
      json: async () => ({}),
    }) as unknown as Response) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('sdk:copilot discovery', () => {
  it('maps Copilot /models into UpsertModelInput[]', async () => {
    mockFetchOk(API_RESPONSE);
    const b = await discoverCopilotModels(copilotSpec, CFG, fakeStore());

    expect(b).toEqual([
      {
        model_id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        display_name: 'GPT-5.6 Terra',
        context_window: 1_050_000,
        default_max_tokens: 128_000,
        can_reason: true,
        supports_attachments: true,
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_reasoning_level: 'medium',
        input_modalities: ['text', 'image'],
        visibility: 'list',
        supported_in_api: true,
        source: 'live',
      },
      {
        model_id: 'mystery-model',
        name: 'mystery-model',
        display_name: 'mystery-model',
        context_window: null,
        default_max_tokens: null,
        can_reason: false,
        supports_attachments: false,
        supported_reasoning_levels: null,
        default_reasoning_level: null,
        input_modalities: ['text'],
        visibility: 'hidden',
        supported_in_api: true,
        source: 'live',
      },
    ]);
    // `name` falls back to id when absent; both builders agree.
    expect(b[1].name).toBe('mystery-model');
  });

  it('throws on a non-ok /models response (no seed/empty fallback)', async () => {
    mockFetchErr(503, 'upstream down');
    await expect(
      discoverCopilotModels(copilotSpec, CFG, fakeStore()),
    ).rejects.toThrow(/Copilot \/models HTTP 503/);
  });

  it('exposes configurable Gemini 3.6 effort but keeps Gemini 3.5 model-managed', () => {
    expect(mapCopilotModel({
      id: 'gemini-3.6-flash',
      capabilities: { supports: { reasoning: true } },
    })).toMatchObject({
      can_reason: true,
      supported_reasoning_levels: ['low', 'medium', 'high'],
      default_reasoning_level: 'medium',
    });
    expect(mapCopilotModel({
      id: 'gemini-3.5-flash',
      capabilities: { supports: { reasoning: true } },
    })).toMatchObject({
      can_reason: true,
      supported_reasoning_levels: null,
      default_reasoning_level: null,
    });
  });
});
