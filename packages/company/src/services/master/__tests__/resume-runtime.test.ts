import { describe, expect, it } from 'vitest';
import { resolveAppMasterResumeRuntime } from '../resume.js';

const base = {
  configuredProvider: 'openai-chatgpt',
  configuredModel: 'gpt-5.6-terra',
  persistedConfiguredProvider: 'openai-chatgpt',
  persistedConfiguredModel: 'gpt-5.6-terra',
  persistedFallbackReason: null,
  sessionProvider: 'openai-chatgpt',
  sessionModel: 'gpt-5.6-terra',
  fallbackModels: [{ provider: 'openai-chatgpt', model: 'gpt-5.6-sol' }],
} as const;

describe('App Master resume runtime reconciliation', () => {
  it('keeps the configured primary when the runtime is unchanged', () => {
    expect(resolveAppMasterResumeRuntime(base)).toEqual({
      configuredProvider: 'openai-chatgpt',
      configuredModel: 'gpt-5.6-terra',
      effectiveProvider: 'openai-chatgpt',
      effectiveModel: 'gpt-5.6-terra',
      fallbackReason: null,
      resetResponseState: false,
    });
  });

  it('keeps an explicitly configured fallback sticky across restart', () => {
    const result = resolveAppMasterResumeRuntime({
      ...base,
      sessionModel: 'gpt-5.6-sol',
      persistedFallbackReason: 'master_fallback_models: provider returned HTTP 503',
    });
    expect(result).toMatchObject({
      effectiveModel: 'gpt-5.6-sol',
      fallbackReason: 'master_fallback_models: provider returned HTTP 503',
      resetResponseState: false,
    });
  });

  it('uses a newly configured primary only on the next resume', () => {
    const result = resolveAppMasterResumeRuntime({
      ...base,
      configuredModel: 'gpt-5.7-terra',
      sessionModel: 'gpt-5.7-terra',
    });
    expect(result).toMatchObject({
      configuredModel: 'gpt-5.7-terra',
      effectiveModel: 'gpt-5.7-terra',
      fallbackReason: null,
      resetResponseState: true,
    });
  });

  it('repairs a leaked global mini model to the configured primary', () => {
    const result = resolveAppMasterResumeRuntime({
      ...base,
      sessionModel: 'gpt-5.4-mini',
      persistedFallbackReason: 'legacy global override',
    });
    expect(result).toMatchObject({
      configuredModel: 'gpt-5.6-terra',
      effectiveModel: 'gpt-5.6-terra',
      fallbackReason: null,
      resetResponseState: true,
    });
  });

  it('fails closed without an authoritative App Master tuple', () => {
    expect(() => resolveAppMasterResumeRuntime({
      ...base,
      configuredModel: '',
    })).toThrow('requires an authoritative provider and model');
  });
});
