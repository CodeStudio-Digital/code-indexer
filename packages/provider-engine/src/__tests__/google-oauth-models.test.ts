import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';

// Mock the shared OAuth refresh at the module boundary. Default: return a fresh token.
vi.mock('@mcp/services/services/oauth/google.js', () => ({
  refreshIfExpired: vi.fn(async () => 'fresh-token'),
}));

import { refreshIfExpired } from '@mcp/services/services/oauth/google.js';
import { discoverGoogleOAuthModels } from '../discovery/google-oauth-models.js';
import { googleOAuthSpec } from '../specs/google-oauth.js';

// The code reads `api_key` (stale fallback) and `id` (refresh) off the config.
const CFG = { id: 7, api_key: 'stale', kind: 'google-oauth' } as unknown as ProviderConfig;

// Fake store — refreshIfExpired is mocked, so no methods are actually invoked.
const STORE = {} as unknown as ProviderStore;

// Representative /v1beta/models payload: one generateContent model, one without
// the method (filtered out), and one missing supportedGenerationMethods (kept by
// the `?? true` branch). Exercises the `models/` strip + displayName fallback.
const API_RESPONSE = {
  models: [
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/embedding-001',
      supportedGenerationMethods: ['embedContent'],
    },
    {
      name: 'models/gemini-no-methods',
    },
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

function mockFetchFail(status: number): void {
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status,
      json: async () => ({}),
    }) as unknown as Response) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.mocked(refreshIfExpired).mockReset();
  vi.mocked(refreshIfExpired).mockResolvedValue('fresh-token');
});

describe('google-oauth-models discovery', () => {
  it('maps Google OAuth /models into UpsertModelInput[]', async () => {
    mockFetchOk(API_RESPONSE);
    const b = await discoverGoogleOAuthModels(googleOAuthSpec, CFG, STORE);

    expect(b).toEqual([
      {
        model_id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        context_window: 1048576,
        default_max_tokens: 65536,
        source: 'live',
      },
      {
        model_id: 'gemini-no-methods',
        name: 'models/gemini-no-methods',
        context_window: null,
        default_max_tokens: null,
        source: 'live',
      },
    ]);
  });

  it('falls back to the stale api_key token when refresh throws', async () => {
    vi.mocked(refreshIfExpired).mockRejectedValue(new Error('boom'));

    mockFetchOk(API_RESPONSE);
    const b = await discoverGoogleOAuthModels(googleOAuthSpec, CFG, STORE);

    expect(b.map((m) => m.model_id)).toEqual(['gemini-2.5-pro', 'gemini-no-methods']);
  });

  it('throws on non-ok HTTP response', async () => {
    mockFetchFail(403);
    await expect(discoverGoogleOAuthModels(googleOAuthSpec, CFG, STORE)).rejects.toThrow('HTTP 403');
  });
});
