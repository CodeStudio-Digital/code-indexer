/**
 * Scheduled background refresh of model token PRICES.
 *
 * Sibling of scheduled-refresh.ts (which refreshes model LISTS). On each
 * cycle this module:
 *   1. Fetches each enabled PriceSource (OpenRouter, LiteLLM).
 *   2. Upserts the normalized rows via replaceModelPricesFromSource — which
 *      only ever touches that source's own rows, so 'manual'/'hardcoded'
 *      pins survive.
 *   3. Re-hydrates the in-memory price cache via mergeDBPricing so
 *      estimateCost() reflects the latest prices without a restart.
 *
 * One source failing never aborts the others. Interval: controlled by
 * MODEL_PRICING_REFRESH_INTERVAL_MS. Default 24h. Set to 0 to disable.
 */
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { PriceSource } from '@mcp/services/services/pricing/index.js';
import { mergeDBPricing } from '@mcp/code-agent/providers/pricing-cache.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_DELAY_MS = 15_000; // 15 s after startup (after the model-list refresh)

export interface PriceRefreshResult {
  sources: Array<{ tag: string; ok: boolean; fetched: number; inserted: number; error?: string }>;
  totalRows: number;
  /** True when at least one source succeeded and the cache was re-hydrated. */
  hydrated: boolean;
}

export async function refreshAllModelPrices(
  store: ProviderStore,
  sources: PriceSource[],
): Promise<PriceRefreshResult> {
  const result: PriceRefreshResult = { sources: [], totalRows: 0, hydrated: false };
  for (const src of sources) {
    try {
      const prices = await src.fetch();
      const fetchedAt = new Date().toISOString();
      const res = store.replaceModelPricesFromSource(
        src.tag,
        prices.map((p) => ({
          provider: p.provider,
          model_id: p.normalizedModelId,
          input_per_mtok: p.input_per_mtok,
          output_per_mtok: p.output_per_mtok,
          cache_read_per_mtok: p.cache_read_per_mtok,
          cache_write_per_mtok: p.cache_write_per_mtok,
          currency: p.currency,
          source_model_ref: p.rawModelId,
          fetched_at: fetchedAt,
        })),
      );
      result.sources.push({ tag: src.tag, ok: true, fetched: prices.length, inserted: res.inserted });
      result.totalRows += res.inserted;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      result.sources.push({ tag: src.tag, ok: false, fetched: 0, inserted: 0, error });
      console.warn(`[model-pricing] ${src.tag} failed: ${error}`);
    }
  }
  if (result.sources.some((s) => s.ok)) {
    mergeDBPricing(store.listAllModelPrices());
    result.hydrated = true;
    const okCount = result.sources.filter((s) => s.ok).length;
    console.log(`[model-pricing] refreshed ${okCount}/${sources.length} sources, ${result.totalRows} rows`);
  }
  return result;
}

/**
 * Start the periodic price-refresh timer. Returns a cleanup function that
 * cancels it (for tests / graceful shutdown).
 */
export function startModelPricingRefreshScheduler(
  store: ProviderStore,
  sources: PriceSource[],
): () => void {
  const intervalMs = Number(process.env.MODEL_PRICING_REFRESH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (intervalMs <= 0) {
    console.log('[model-pricing] background refresh disabled (MODEL_PRICING_REFRESH_INTERVAL_MS=0)');
    return () => { /* no-op */ };
  }

  const initialTimer = setTimeout(() => {
    refreshAllModelPrices(store, sources).catch((e) =>
      console.warn(`[model-pricing] initial run failed: ${e instanceof Error ? e.message : String(e)}`)
    );
  }, INITIAL_DELAY_MS);

  const intervalTimer = setInterval(() => {
    refreshAllModelPrices(store, sources).catch((e) =>
      console.warn(`[model-pricing] periodic run failed: ${e instanceof Error ? e.message : String(e)}`)
    );
  }, intervalMs);

  initialTimer.unref();
  intervalTimer.unref();

  console.log(`[model-pricing] scheduler started (interval=${intervalMs / 1000}s, initial delay=${INITIAL_DELAY_MS / 1000}s)`);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  };
}
