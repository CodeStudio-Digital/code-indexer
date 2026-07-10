/**
 * Fase 3 — "Economia Real" savings math. Pure function; pricing resolver is
 * injected so no DB/network. Pins the honest contract:
 *  - cache saving = read × (input_rate − cacheRead_rate)  [EXACT]
 *  - shaping saving = raw − shaped chars                   [EXACT fwd]
 *  - tier saving = (eligible_catalog − active) / 4         [ESTIMATE]
 */
import { describe, it, expect } from 'vitest';
import { computeSavings, type TurnForSavings } from '../telemetry-savings.js';
import type { ModelPricing } from '@mcp/code-agent/providers/pricing.js';

const PRICED: ModelPricing = { input: 3, output: 15, cacheRead: 0.3 };
const resolve = (_p: string | null, m: string | null): ModelPricing | null =>
  m === 'known' ? PRICED : null;

const turn = (over: Partial<TurnForSavings>): TurnForSavings => ({
  provider: 'anthropic',
  model: 'known',
  input_tokens: 0,
  cache_read_input_tokens: 0,
  tools_def_chars: null,
  eligible_tools_def_chars: null,
  ...over,
});

describe('computeSavings', () => {
  it('computes cache saving as read × (input − cacheRead)', () => {
    const r = computeSavings({
      turns: [turn({ input_tokens: 100_000, cache_read_input_tokens: 100_000 })],
      rawToolChars: 0,
      shapedToolChars: 0,
      resolvePricing: resolve,
    });
    // 100_000 × (3 − 0.3) / 1e6 = 0.27
    expect(r.cacheSavedUsd).toBeCloseTo(0.27, 6);
    expect(r.cacheReadTokens).toBe(100_000);
    expect(r.cacheHitRatio).toBeCloseTo(1, 6);
  });

  it('counts zero cache saving when the model has no cacheRead rate', () => {
    const r = computeSavings({
      turns: [turn({ model: 'known', input_tokens: 10_000, cache_read_input_tokens: 5_000, tools_def_chars: null })],
      rawToolChars: 0,
      shapedToolChars: 0,
      resolvePricing: (_p, _m) => ({ input: 3, output: 15 }), // no cacheRead → defaults to input
    });
    expect(r.cacheSavedUsd).toBe(0);
  });

  it('flags unpriced turns (cache $ undercounts)', () => {
    const r = computeSavings({
      turns: [turn({ model: 'mystery', input_tokens: 10_000, cache_read_input_tokens: 9_000 })],
      rawToolChars: 0,
      shapedToolChars: 0,
      resolvePricing: resolve,
    });
    expect(r.hasUnpricedTurns).toBe(true);
    expect(r.cacheSavedUsd).toBe(0);
  });

  it('computes shaping savings (chars + tokens + gross $)', () => {
    const r = computeSavings({
      turns: [turn({ input_tokens: 1_000_000 })], // weights avg input rate = 3
      rawToolChars: 40_000,
      shapedToolChars: 10_000,
      resolvePricing: resolve,
    });
    expect(r.shapingSavedChars).toBe(30_000);
    expect(r.shapingSavedTokensEst).toBe(7_500); // 30000 / 4
    expect(r.shapingSavedUsdEst).toBeCloseTo((7_500 * 3) / 1_000_000, 9);
  });

  it('estimates tier savings from full-catalog counterfactual', () => {
    const r = computeSavings({
      turns: [
        turn({ tools_def_chars: 60_000, eligible_tools_def_chars: 180_000 }),
        turn({ tools_def_chars: 60_000, eligible_tools_def_chars: 180_000 }),
      ],
      rawToolChars: 0,
      shapedToolChars: 0,
      resolvePricing: resolve,
    });
    // Serialized eligible catalog is 180k → (180000 − 60000)/4 = 30000/turn.
    expect(r.tierSavedTokensEstPerTurn).toBe(30_000);
    expect(r.tierSavedTokensEstTotal).toBe(60_000); // × 2 turns
  });

  it('falls back to zero tier savings for historical rows without eligible catalog size', () => {
    const r = computeSavings({
      turns: [turn({ tools_def_chars: 60_000, eligible_tools_def_chars: null })],
      rawToolChars: 0,
      shapedToolChars: 0,
      resolvePricing: resolve,
    });
    expect(r.tierSavedTokensEstPerTurn).toBe(0);
  });

  it('returns zeros for an empty session without crashing', () => {
    const r = computeSavings({ turns: [], rawToolChars: 0, shapedToolChars: 0, resolvePricing: resolve });
    expect(r.cacheSavedUsd).toBe(0);
    expect(r.shapingSavedChars).toBe(0);
    expect(r.cacheHitRatio).toBe(0);
    expect(r.hasUnpricedTurns).toBe(false);
  });
});
