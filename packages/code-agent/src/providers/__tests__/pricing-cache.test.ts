/**
 * Pricing resolver — locks the resolution precedence and the cost math.
 *
 *   env override > DB (provider-qualified > bare) > static (exact > prefix) > none
 *
 * Also pins the reported-bug fix: claude-opus-4-8[1m] must resolve to the
 * 1M-tier static row, NOT inherit opus-4-7 via the broad 'claude-opus' prefix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mergeDBPricing,
  resolvePricingWithSource,
  estimateCost,
  getRecentMissingPrices,
  clearMissingPricesForTest,
  clearOverrideForTest,
} from '../pricing-cache.js';

beforeEach(() => {
  mergeDBPricing([]); // reset DB layer
  clearMissingPricesForTest();
  delete process.env.CODER_MODEL_PRICING;
  clearOverrideForTest();
});

afterEach(() => {
  delete process.env.CODER_MODEL_PRICING;
  clearOverrideForTest();
});

describe('resolvePricingWithSource — precedence', () => {
  it('env override wins over everything', () => {
    process.env.CODER_MODEL_PRICING = JSON.stringify({ 'claude-opus-4-7': { input: 1, output: 2 } });
    clearOverrideForTest();
    const r = resolvePricingWithSource('anthropic', 'claude-opus-4-7');
    expect(r.source).toBe('env');
    expect(r.pricing?.input).toBe(1);
  });

  it('DB provider-qualified beats bare DB row', () => {
    mergeDBPricing([
      { provider: '', model_id: 'foo-1', input_per_mtok: 1, output_per_mtok: 2, cache_read_per_mtok: null, cache_write_per_mtok: null, source: 'litellm' },
      { provider: 'anthropic', model_id: 'foo-1', input_per_mtok: 5, output_per_mtok: 6, cache_read_per_mtok: null, cache_write_per_mtok: null, source: 'litellm' },
    ]);
    expect(resolvePricingWithSource('anthropic', 'foo-1').source).toBe('db-provider');
    expect(resolvePricingWithSource('anthropic', 'foo-1').pricing?.input).toBe(5);
    // Different provider falls through to the bare (cross-provider) row.
    expect(resolvePricingWithSource('openai', 'foo-1').source).toBe('db');
    expect(resolvePricingWithSource('openai', 'foo-1').pricing?.input).toBe(1);
  });

  it('mergeDBPricing keeps the higher-priority source (litellm > openrouter)', () => {
    mergeDBPricing([
      { provider: '', model_id: 'gpt-4o', input_per_mtok: 2.5, output_per_mtok: 10, cache_read_per_mtok: 1.25, cache_write_per_mtok: null, source: 'openrouter' },
      { provider: '', model_id: 'gpt-4o', input_per_mtok: 2.0, output_per_mtok: 8, cache_read_per_mtok: 1.0, cache_write_per_mtok: null, source: 'litellm' },
    ]);
    expect(resolvePricingWithSource(null, 'gpt-4o').pricing?.input).toBe(2.0);
  });

  it('falls back to the static table when no DB/env row', () => {
    const r = resolvePricingWithSource('anthropic', 'claude-opus-4-7');
    expect(r.source).toBe('static');
    expect(r.pricing?.input).toBe(15);
  });

  it('unknown model → none + recorded in the missing-price tracker', () => {
    const r = resolvePricingWithSource('x', 'totally-unknown-zzz');
    expect(r.pricing).toBeNull();
    expect(r.source).toBe('none');
    expect(getRecentMissingPrices().some((e) => e.model === 'totally-unknown-zzz')).toBe(true);
  });
});

describe('resolvePricingWithSource — opus-4-8[1m] bug fix', () => {
  it('1M tier resolves to its own static row, not opus-4-7', () => {
    expect(resolvePricingWithSource(null, 'claude-opus-4-8[1m]').pricing?.input).toBe(30);
  });
  it('non-1M opus-4-8 resolves to the base row', () => {
    expect(resolvePricingWithSource(null, 'claude-opus-4-8').pricing?.input).toBe(15);
  });
});

describe('estimateCost — math', () => {
  it('prices 1M input + 1M output at the model rate', () => {
    const cost = estimateCost('anthropic', 'claude-opus-4-7', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBeCloseTo(90, 6); // 15 input + 75 output
  });

  it('re-prices the cached fraction at the cheaper cache rate', () => {
    const cost = estimateCost('anthropic', 'claude-opus-4-7', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    });
    // input billed = max(0, 1M - 1M) = 0; cache read 1M * 1.5 = 1.5
    expect(cost).toBeCloseTo(1.5, 6);
  });

  it('returns 0 for unknown model (never throws)', () => {
    expect(estimateCost('x', 'totally-unknown-zzz', { input_tokens: 100 })).toBe(0);
  });
});
