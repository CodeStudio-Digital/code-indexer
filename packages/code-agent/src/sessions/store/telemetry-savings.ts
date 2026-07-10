import type { ModelPricing } from '@mcp/code-agent/providers/pricing.js';

/**
 * "Economia Real" — per-technique savings estimate from already-captured
 * telemetry. Pure function (pricing resolver injected) so it's unit-testable
 * without a DB.
 *
 * Honesty notes baked into the design:
 *  - **Cache** is EXACT and retroactive: cache_read tokens were billed at the
 *    cheap cache rate instead of full input. saving = read × (input − cacheRead).
 *  - **Shaping** (reducers/json-crush/cap) is exact going FORWARD only — older
 *    rows have output_chars_shaped = NULL (the writer raced; fixed in Fase 3),
 *    so COALESCE makes their saving 0. Reported primarily in tokens; the $ is a
 *    gross upper bound (most shaped bytes are cached on re-send).
 *  - **Tiers/skills** is a labeled ESTIMATE: counterfactual full-catalog size
 *    minus the active tools array. Not exact (full size varies per session).
 */

const CHARS_PER_TOKEN = 4;
export interface TurnForSavings {
  provider: string | null;
  model: string | null;
  input_tokens: number;
  cache_read_input_tokens: number;
  tools_def_chars: number | null;
  eligible_tools_def_chars?: number | null;
}

export interface SavingsInput {
  turns: TurnForSavings[];
  /** SUM(output_chars) — raw tool output (pre-reduce). */
  rawToolChars: number;
  /** SUM(COALESCE(output_chars_shaped, output_chars)) — what the LLM saw. */
  shapedToolChars: number;
  resolvePricing: (provider: string | null, model: string | null) => ModelPricing | null;
}

export interface SavingsBreakdown {
  /** EXACT — USD saved by reading from cache instead of full-price input. */
  cacheSavedUsd: number;
  cacheReadTokens: number;
  cacheHitRatio: number;
  /** EXACT (forward) — chars dropped by reducers/json-crush/cap. */
  shapingSavedChars: number;
  shapingSavedTokensEst: number;
  /** Gross upper bound — most shaped bytes are cached on re-send. */
  shapingSavedUsdEst: number;
  /** ESTIMATE — tokens/turn the tier system keeps out of the tools array. */
  tierSavedTokensEstPerTurn: number;
  tierSavedTokensEstTotal: number;
  /** True when at least one turn had no resolvable price (cache $ undercounts). */
  hasUnpricedTurns: boolean;
}

export function computeSavings(input: SavingsInput): SavingsBreakdown {
  const { turns, rawToolChars, shapedToolChars, resolvePricing } = input;

  let cacheSavedUsd = 0;
  let cacheReadTokens = 0;
  let totalInputTokens = 0;
  let weightedRateNum = 0; // Σ input_rate × input_tokens (priced turns)
  let weightedRateDen = 0; // Σ input_tokens (priced turns)
  let toolsDefCharsSum = 0;
  let toolsDefCharsCount = 0;
  let eligibleToolsDefCharsSum = 0;
  let eligibleToolsDefCharsCount = 0;
  let hasUnpricedTurns = false;

  for (const t of turns) {
    cacheReadTokens += t.cache_read_input_tokens;
    totalInputTokens += t.input_tokens;
    if (t.tools_def_chars != null) {
      toolsDefCharsSum += t.tools_def_chars;
      toolsDefCharsCount++;
    }
    if (t.eligible_tools_def_chars != null) {
      eligibleToolsDefCharsSum += t.eligible_tools_def_chars;
      eligibleToolsDefCharsCount++;
    }
    const pricing = resolvePricing(t.provider, t.model);
    if (!pricing) {
      if (t.input_tokens > 0 || t.cache_read_input_tokens > 0) hasUnpricedTurns = true;
      continue;
    }
    const cacheReadRate = pricing.cacheRead ?? pricing.input;
    cacheSavedUsd += (t.cache_read_input_tokens * (pricing.input - cacheReadRate)) / 1_000_000;
    weightedRateNum += pricing.input * t.input_tokens;
    weightedRateDen += t.input_tokens;
  }

  const avgInputRate = weightedRateDen > 0 ? weightedRateNum / weightedRateDen : 0;

  const shapingSavedChars = Math.max(0, rawToolChars - shapedToolChars);
  const shapingSavedTokensEst = Math.round(shapingSavedChars / CHARS_PER_TOKEN);
  const shapingSavedUsdEst = (shapingSavedTokensEst * avgInputRate) / 1_000_000;

  const avgToolsDefChars = toolsDefCharsCount > 0 ? toolsDefCharsSum / toolsDefCharsCount : 0;
  const avgEligibleToolsDefChars = eligibleToolsDefCharsCount > 0
    ? eligibleToolsDefCharsSum / eligibleToolsDefCharsCount
    : avgToolsDefChars;
  const tierSavedTokensEstPerTurn = Math.max(
    0,
    Math.round((avgEligibleToolsDefChars - avgToolsDefChars) / CHARS_PER_TOKEN),
  );

  return {
    cacheSavedUsd,
    cacheReadTokens,
    cacheHitRatio: totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0,
    shapingSavedChars,
    shapingSavedTokensEst,
    shapingSavedUsdEst,
    tierSavedTokensEstPerTurn,
    tierSavedTokensEstTotal: tierSavedTokensEstPerTurn * turns.length,
    hasUnpricedTurns,
  };
}
