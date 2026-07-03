import { describe, it, expect, afterEach } from 'vitest';
import type {
  ProviderConfig,
  ProviderStore,
} from '@mcp/store/provider-store.js';

import { discoverCopilotModels } from '../discovery/copilot-models.js';
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

// Representative /models payload: id + optional name. `gpt-4o` is in the
// capability registry (non-null context_window); `mystery-model` is absent
// (null) — pinning both branches of `getRegistryContextWindow`.
const API_RESPONSE = {
  data: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'mystery-model' },
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
        model_id: 'gpt-4o',
        name: 'GPT-4o',
        context_window: expect.anything(),
        source: 'live',
      },
      {
        model_id: 'mystery-model',
        name: 'mystery-model',
        context_window: null,
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
});
