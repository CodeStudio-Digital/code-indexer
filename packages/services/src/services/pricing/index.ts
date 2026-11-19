/**
 * Model-pricing source layer. Each source fetches an upstream price list and
 * returns normalized rows (USD/1M tokens, canonical id). The refresh job in
 * packages/indexer upserts them into model_prices.
 */
import type { PriceSource } from './types.js';
import { OpenRouterPriceSource } from './openrouter-source.js';
import { LiteLLMPriceSource } from './litellm-source.js';

export type { PriceSource, NormalizedPrice } from './types.js';
export { normalizeModelId, perTokenToPerMtok } from './normalize.js';
export { OpenRouterPriceSource } from './openrouter-source.js';
export { LiteLLMPriceSource } from './litellm-source.js';

export interface PriceSourceConfig {
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
}

export function isRemotePriceSyncEnabled(): boolean {
  const value = process.env.MODEL_PRICING_REMOTE_ENABLED?.trim().toLowerCase();
  return value !== 'false' && value !== '0';
}

/**
 * The enabled price sources. Order is documentation only (the cache merge
 * applies its own source priority); LiteLLM first as the higher-trust source.
 */
export function getEnabledPriceSources(config: PriceSourceConfig = {}): PriceSource[] {
  return [
    new LiteLLMPriceSource(),
    new OpenRouterPriceSource({
      baseUrl: config.openrouterBaseUrl,
      apiKey: config.openrouterApiKey,
    }),
  ];
}
