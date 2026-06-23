/**
 * Shared shapes for the model-pricing source layer.
 *
 * A PriceSource fetches an upstream price list and returns rows already
 * normalized to our canonical unit (USD per 1M tokens) and canonical model
 * id. The refresh job (packages/indexer) upserts them into model_prices.
 */
export interface NormalizedPrice {
  /** '' = cross-provider price list (OpenRouter / LiteLLM). */
  provider: string;
  /** Raw upstream id, kept for audit/debug (model_prices.source_model_ref). */
  rawModelId: string;
  /** Canonical internal id: vendor-stripped, lowercased, alias-mapped. */
  normalizedModelId: string;
  /** USD per 1M tokens. Null when the source doesn't publish the field. */
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  currency: string;
}

export interface PriceSource {
  readonly tag: 'openrouter' | 'litellm' | 'cloudflare';
  /**
   * Fetch + normalize. MUST NOT throw on a single bad row — skip it. May
   * throw on a hard failure (network / non-200 / unparseable body); the
   * caller isolates each source so one failure doesn't abort the others.
   */
  fetch(): Promise<NormalizedPrice[]>;
}
