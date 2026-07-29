import { describe, it, expect, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

import { discoverAnthropicModels } from '../discovery/anthropic-models.js';
import { anthropicSpec } from '../specs/anthropic.js';

// The discovery helper only reads `api_key` and `base_url` off the config, so a
// minimal partial is enough; cast to the full row type for the call.
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

describe('anthropic-models discovery', () => {
  it('maps Anthropic /v1/models into UpsertModelInput[]', async () => {
    mockFetchOk(API_RESPONSE);
    const b = await discoverAnthropicModels(anthropicSpec, CFG);

    expect(b).toEqual([
      {
        model_id: 'claude-x',
        name: 'Claude X',
        context_window: null,
        source: 'live',
      },
    ]);
  });

  it('uses the current Models API token limits and reasoning capabilities', async () => {
    mockFetchOk({
      data: [{
        id: 'claude-opus-5',
        display_name: 'Claude Opus 5',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: true },
            max: { supported: true },
          },
          thinking: {
            supported: true,
            types: {
              adaptive: { supported: true },
              enabled: { supported: false },
            },
          },
          image_input: { supported: true },
          pdf_input: { supported: true },
        },
      }],
    });

    const b = await discoverAnthropicModels(anthropicSpec, CFG);
    expect(b).toEqual([expect.objectContaining({
      model_id: 'claude-opus-5',
      name: 'Claude Opus 5',
      context_window: 1_000_000,
      default_max_tokens: 128_000,
      can_reason: true,
      supports_attachments: true,
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'live',
    })]);
  });
});
