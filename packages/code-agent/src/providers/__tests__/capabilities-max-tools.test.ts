/**
 * Tests for the max-tools resolution chain (model-adaptive tool exposure).
 *
 * Locks three things in place:
 *
 *   1. The aggressive GLM caps in MODEL_REGISTRY (32/48/96). The original
 *      bug was every glm-* shipping maxTools 200, so the cap never fired
 *      and weak models drowned in 56–90 tools on turn 1.
 *   2. MAX_TOOLS_PREFIX_FALLBACKS — new GLM variants must not silently
 *      regress to the 200 default (which is how the bug was born).
 *   3. The DB layer: mergeDBCapabilities carries max_tools (admin-set via
 *      provider_models) and it beats the static registry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getMaxOutputTokens,
  getModelMaxTools,
  getModelContextWindow,
  mergeDBCapabilities,
} from '../capabilities.js';

afterEach(() => {
  // dbLayer is a module global — always drain it so other capability tests
  // (and other cases in this file) see a clean slate.
  mergeDBCapabilities([]);
});

describe('getModelMaxTools — static registry (GLM aggressive caps)', () => {
  it('glm flash/air class → 32', () => {
    expect(getModelMaxTools('glm-4.7-flash')).toBe(32);
    expect(getModelMaxTools('glm-4.5-flash')).toBe(32);
    expect(getModelMaxTools('glm-4.5-air')).toBe(32);
    expect(getModelMaxTools('glm-4.5-x')).toBe(32);
    expect(getModelMaxTools('glm-4.5-airx')).toBe(32);
  });
  it('glm-4.5 / glm-4.6 base → 48', () => {
    expect(getModelMaxTools('glm-4.5')).toBe(48);
    expect(getModelMaxTools('glm-4.6')).toBe(48);
  });
  it('glm-5.x → 96', () => {
    expect(getModelMaxTools('glm-5.1')).toBe(96);
    expect(getModelMaxTools('zai.glm-5')).toBe(96);
    expect(getModelMaxTools('z-ai/glm-5')).toBe(96);
    expect(getModelMaxTools('@cf/zai-org/glm-5.2')).toBe(96);
  });
  it('strong models keep large catalogs', () => {
    expect(getModelMaxTools('claude-opus-4-7')).toBe(200);
    expect(getModelMaxTools('gpt-5.5')).toBe(128);
  });
});

describe('getModelMaxTools — prefix fallbacks (anti-regression for new variants)', () => {
  it('unknown glm flash variant inherits the flash cap, not 200', () => {
    expect(getModelMaxTools('glm-4.5-flash-250901')).toBe(32);
    expect(getModelMaxTools('glm-4.7-flash-preview')).toBe(32);
  });
  it('unknown glm-5 variant → 96', () => {
    expect(getModelMaxTools('glm-5-pro-preview')).toBe(96);
  });
  it('unknown glm-4 variant → 48 (generic family floor)', () => {
    expect(getModelMaxTools('glm-4.9')).toBe(48);
  });
  it('unrelated unknown model → 200 default', () => {
    expect(getModelMaxTools('totally-unknown-model')).toBe(200);
  });
});

describe('getModelMaxTools — DB layer (admin override)', () => {
  it('DB max_tools beats the static registry', () => {
    mergeDBCapabilities([{ model_id: 'glm-4.5-flash', context_window: null, max_tools: 20 }]);
    expect(getModelMaxTools('glm-4.5-flash')).toBe(20);
  });
  it('clearing the DB layer restores the registry value', () => {
    mergeDBCapabilities([{ model_id: 'glm-4.5-flash', context_window: null, max_tools: 20 }]);
    mergeDBCapabilities([]);
    expect(getModelMaxTools('glm-4.5-flash')).toBe(32);
  });
  it('rows without max_tools leave the registry value in charge', () => {
    mergeDBCapabilities([{ model_id: 'glm-4.5-flash', context_window: 128_000 }]);
    expect(getModelMaxTools('glm-4.5-flash')).toBe(32);
  });
  it('context_window keeps working through the new dbLayer shape', () => {
    mergeDBCapabilities([{ model_id: 'my-custom-model', context_window: 64_000, max_tools: 16 }]);
    expect(getModelContextWindow('my-custom-model')).toBe(64_000);
    expect(getModelMaxTools('my-custom-model')).toBe(16);
  });
});

describe('getMaxOutputTokens — DB layer (per-model output cap)', () => {
  it('DB default_max_tokens beats the static registry', () => {
    mergeDBCapabilities([{
      model_id: 'glm-5.1',
      context_window: null,
      default_max_tokens: 24_000,
    }]);
    expect(getMaxOutputTokens('glm-5.1')).toBe(24_000);
    expect(getMaxOutputTokens('zai.glm-5.1')).toBe(24_000);
  });

  it('clearing the DB layer restores the registry value', () => {
    mergeDBCapabilities([{
      model_id: 'glm-5.1',
      context_window: null,
      default_max_tokens: 24_000,
    }]);
    mergeDBCapabilities([]);
    expect(getMaxOutputTokens('glm-5.1')).toBe(16_000);
    expect(getMaxOutputTokens('zai.glm-5.1')).toBe(16_000);
  });
});
