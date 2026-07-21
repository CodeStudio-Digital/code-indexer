import { describe, expect, it } from 'vitest';
import { hydrateModel, type ProviderModelRaw } from '../hydrators.js';

function rawModel(overrides: Partial<ProviderModelRaw>): ProviderModelRaw {
  return {
    provider_id: 'chatgpt',
    model_id: 'gpt-test',
    mode: '',
    name: 'GPT test',
    context_window: null,
    context_window_overridden: 0,
    default_max_tokens: null,
    can_reason: 0,
    supports_attachments: 0,
    enabled: 1,
    source: 'live',
    updated_at: '2026-07-18T00:00:00Z',
    display_name: null,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: null,
    apply_patch_tool_type: null,
    available_in_plans: null,
    minimal_client_version: null,
    visibility: null,
    supported_in_api: 1,
    input_modalities: null,
    max_tools: null,
    ...overrides,
  };
}

describe('provider model reasoning hydration', () => {
  it('repairs stale can_reason metadata from native levels and removes Ultra', () => {
    const model = hydrateModel(rawModel({
      default_reasoning_level: 'ultra',
      supported_reasoning_levels: JSON.stringify(['high', 'max', 'ultra']),
    }));

    expect(model.can_reason).toBe(true);
    expect(model.default_reasoning_level).toBeNull();
    expect(model.supported_reasoning_levels).toEqual(['high', 'max']);
  });

  it('does not infer reasoning for a model with no native metadata', () => {
    expect(hydrateModel(rawModel({})).can_reason).toBe(false);
  });
});
