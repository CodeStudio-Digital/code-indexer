/**
 * Model-id normalization + unit conversion, plus a parse smoke-test per
 * source with a stubbed fetch. These lock the upstream→canonical mapping so
 * a price row keys against what estimateCost() looks up.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { normalizeModelId, perTokenToPerMtok } from '../normalize.js';
import { OpenRouterPriceSource } from '../openrouter-source.js';
import { LiteLLMPriceSource } from '../litellm-source.js';

describe('normalizeModelId', () => {
  it('strips vendor namespace', () => {
    expect(normalizeModelId('openai/gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelId('google/gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });
  it('applies the family alias (generic → specific build)', () => {
    expect(normalizeModelId('anthropic/claude-opus-4')).toBe('claude-opus-4-8');
    expect(normalizeModelId('moonshotai/kimi-k2')).toBe('kimi-k2.6');
  });
  it('strips OpenRouter route suffixes', () => {
    expect(normalizeModelId('deepseek/deepseek-chat:free')).toBe('deepseek-chat');
    expect(normalizeModelId('z-ai/glm-4.6:beta')).toBe('glm-4.6');
  });
  it('keeps @cf/ ids verbatim (lowercased)', () => {
    expect(normalizeModelId('@cf/baai/bge-m3')).toBe('@cf/baai/bge-m3');
  });
  it('preserves our variant tags (no alias for the 1M tier)', () => {
    expect(normalizeModelId('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
  });
  it('is case-insensitive and trims', () => {
    expect(normalizeModelId('  OpenAI/GPT-4O  ')).toBe('gpt-4o');
  });
});

describe('perTokenToPerMtok', () => {
  it('converts numeric strings and numbers', () => {
    expect(perTokenToPerMtok('0.000015')).toBeCloseTo(15, 9);
    expect(perTokenToPerMtok(0.000003)).toBeCloseTo(3, 9);
  });
  it('returns null for absent / empty / invalid / negative', () => {
    expect(perTokenToPerMtok(undefined)).toBeNull();
    expect(perTokenToPerMtok(null)).toBeNull();
    expect(perTokenToPerMtok('')).toBeNull();
    expect(perTokenToPerMtok('abc')).toBeNull();
    expect(perTokenToPerMtok(-1)).toBeNull();
  });
});

describe('source parsing (stubbed fetch)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('OpenRouter: maps pricing object → per-Mtok + normalized id', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-opus-4',
            pricing: { prompt: '0.000015', completion: '0.000075', input_cache_read: '0.0000015' },
          },
          { id: 'no-pricing/model' }, // skipped (no pricing)
        ],
      }),
    })) as unknown as typeof fetch;

    const rows = await new OpenRouterPriceSource().fetch();
    expect(rows).toHaveLength(1);
    expect(rows[0].normalizedModelId).toBe('claude-opus-4-8');
    expect(rows[0].input_per_mtok).toBeCloseTo(15, 9);
    expect(rows[0].output_per_mtok).toBeCloseTo(75, 9);
    expect(rows[0].cache_read_per_mtok).toBeCloseTo(1.5, 9);
    expect(rows[0].cache_write_per_mtok).toBeNull();
  });

  it('LiteLLM: skips sample_spec + embedding modes, converts costs', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        sample_spec: { note: 'ignore me' },
        'gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001, mode: 'chat' },
        'text-embedding-3-small': { input_cost_per_token: 0.00000002, mode: 'embedding' },
      }),
    })) as unknown as typeof fetch;

    const rows = await new LiteLLMPriceSource().fetch();
    expect(rows).toHaveLength(1);
    expect(rows[0].normalizedModelId).toBe('gpt-4o');
    expect(rows[0].input_per_mtok).toBeCloseTo(2.5, 9);
    expect(rows[0].output_per_mtok).toBeCloseTo(10, 9);
  });

  it('throws on non-200 (caller isolates the failure)', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(new OpenRouterPriceSource().fetch()).rejects.toThrow(/503/);
  });
});
