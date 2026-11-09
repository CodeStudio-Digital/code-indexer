import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverOpenAIModels } from '../discovery/openai-models.js';
import { openaiSpec } from '../specs/openai-compat.js';
import { OPENAI_API_MODELS, getOpenAIApiModelMetadata } from '@mcp/shared/providers/openai-api-models.js';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

const cfg = { id: 'my-openai-key', kind: 'openai', api_key: 'synthetic', base_url: null, extra: {} } as ProviderConfig;
afterEach(() => vi.unstubAllGlobals());
const listing = (data: unknown[]) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data }) })));

describe('OpenAI public API catalog', () => {
  it.each(Object.keys(OPENAI_API_MODELS))('enriches %s from the API catalog instead of Codex limits', async modelId => {
    listing([{ id: modelId }]);
    const [model] = await discoverOpenAIModels(openaiSpec, cfg);
    const published = OPENAI_API_MODELS[modelId]!;
    expect(model).toMatchObject({ model_id: modelId, source: 'live', context_window: published.contextWindow,
      default_max_tokens: published.maxTokens, can_reason: published.canReason,
      supported_reasoning_levels: published.supportedReasoningLevels, default_reasoning_level: published.defaultReasoningLevel });
  });

  it('inherits only dated snapshots, with distinct Pro effort controls', async () => {
    listing(['gpt-5.5-2026-04-23', 'gpt-5.5-pro-2026-04-23', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id })));
    const models = await discoverOpenAIModels(openaiSpec, cfg);
    expect(models.every(model => model.context_window === 1_050_000)).toBe(true);
    expect(models[0]!.supported_reasoning_levels).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(models[1]!.supported_reasoning_levels).toEqual(['medium', 'high', 'xhigh']);
    expect(models[1]!.default_reasoning_level).toBe('high');
    expect(models[2]!.supported_reasoning_levels).not.toContain('none');
    expect(models[3]!.supported_reasoning_levels).toContain('none');
  });

  it('keeps actual endpoint metadata above the documented fallback', async () => {
    listing([{ id: 'gpt-5.6-sol', context_window: 900_000, max_output_tokens: 48_000, supported_reasoning_levels: ['high'] }]);
    expect((await discoverOpenAIModels(openaiSpec, cfg))[0]).toMatchObject({ context_window: 900_000,
      default_max_tokens: 48_000, supported_reasoning_levels: ['high'] });
  });

  it('does not fabricate access, reasoning or one-million context for unknown variants', async () => {
    listing([{ id: 'gpt-6-astra-experimental' }, { id: 'gpt-image-2' }, { id: 'gpt-audio' }]);
    const models = await discoverOpenAIModels(openaiSpec, cfg);
    expect(models).toHaveLength(3);
    for (const model of models) {
      expect(model.context_window).toBeNull();
      expect(model.supported_reasoning_levels).toBeUndefined();
    }
    expect(getOpenAIApiModelMetadata('gpt-5.5-mini')).toBeUndefined();
    expect(getOpenAIApiModelMetadata('ft:gpt-6-astra:custom')).toBeUndefined();
  });
});
