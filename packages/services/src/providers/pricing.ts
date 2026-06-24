import { listDefinitions } from './registry.js';
import type { PricingEntry } from './types.js';

/**
 * Central pricing lookup. Walks the registry to find the first definition
 * whose `pricing` map contains the requested model. This replaces the
 * hardcoded PRICING map formerly in src/core/services/costs.ts.
 *
 * Returns zero pricing for unknown models — matches the legacy fallback
 * behavior so the indexer never throws on a model name it doesn't know.
 *
 * Candidates are walked in ascending `pricingPriority` (default 0) before the
 * first-match: a provider can pin its precedence for a cross-provider duplicate
 * model id as DATA, independent of registry/plugin load order. The sort is
 * stable, so with no priorities set the walk is the registry insertion order —
 * byte-identical to the legacy first-match.
 */
export function lookupPricing(model: string): PricingEntry {
  const ordered = [...listDefinitions()].sort(
    (a, b) => (a.pricingPriority ?? 0) - (b.pricingPriority ?? 0),
  );
  for (const def of ordered) {
    const entry = def.pricing[model];
    if (entry) return entry;
  }
  return { inputPer1M: 0, outputPer1M: 0 };
}

/**
 * Calculate the USD cost of a single call given model + token counts.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = lookupPricing(model);
  return (inputTokens * p.inputPer1M + outputTokens * p.outputPer1M) / 1_000_000;
}
