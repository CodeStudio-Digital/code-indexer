import { describe, it, expect, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

import { discoverAnthropic } from '@apps/http-api/admin/model-discovery/anthropic.js';
import { discoverAnthropicModels } from '../discovery/anthropic-models.js';
import { anthropicSpec } from '../specs/anthropic.js';

// The admin helper only reads `api_key` and `base_url` off the config, so a
// minimal partial is enough; cast to the full row type for the shared call.
const CFG = { api_key: 'k', base_url: null } as unknown as ProviderConfig;

// Representative `/v1/models` payload: id + optional display_name. `claude-x`
// is absent from the capability registry, so `getRegistryContextWindow`
// returns null for it — pinning the null-context branch in both builders.
const API_RESPONSE = {
  data: [{ id: 'claude-x', display_name: 'Claude X' }],
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

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('anthropic-models discovery equivalence: engine(spec, cfg) == admin discoverAnthropic(cfg)', () => {
  it('returns identical UpsertModelInput[]', async () => {
    mockFetchOk(API_RESPONSE);
    const a = await discoverAnthropic(CFG);

    mockFetchOk(API_RESPONSE);
    const b = await discoverAnthropicModels(anthropicSpec, CFG);

    expect(b).toEqual(a);
    // Pin the lifted shape so a future drift in either builder is caught.
    expect(b).toEqual([
      {
        model_id: 'claude-x',
        name: 'Claude X',
        context_window: null,
        source: 'live',
      },
    ]);
  });
});
