import { describe, expect, it } from 'vitest';
import { resolveAnthropicRequestModel } from '../anthropic.js';

describe('Anthropic current model request controls', () => {
  it('uses adaptive thinking and native max effort for Opus 5', () => {
    expect(resolveAnthropicRequestModel(
      'claude-opus-5',
      { thinking: true, reasoningEffort: 'max' },
      { supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    )).toMatchObject({
      apiModel: 'claude-opus-5',
      maxTokens: 128_000,
      thinking: { type: 'adaptive', display: 'summarized' },
      outputConfig: { effort: 'max' },
      effort: 'max',
    });
  });

  it('keeps Fable 5 adaptive even when the caller does not enable thinking', () => {
    expect(resolveAnthropicRequestModel(
      'claude-fable-5',
      { thinking: false, reasoningEffort: null },
    )).toMatchObject({
      apiModel: 'claude-fable-5',
      maxTokens: 128_000,
      thinking: { type: 'adaptive', display: 'summarized' },
    });
  });

  it('does not send adaptive thinking or effort to Haiku 4.5', () => {
    expect(resolveAnthropicRequestModel(
      'claude-haiku-4-5-20251001',
      { thinking: false, reasoningEffort: 'max' },
      { supported_reasoning_levels: null },
    )).toEqual({
      apiModel: 'claude-haiku-4-5-20251001',
      requestedModel: 'claude-haiku-4-5-20251001',
      displayModel: 'claude-haiku-4-5-20251001',
      maxTokens: 32_000,
      thinking: undefined,
      outputConfig: undefined,
      effort: null,
    });
  });
});
