import type { NormalizedPrice, PriceSource } from './types.js';
import { normalizeModelId, perTokenToPerMtok } from './normalize.js';

/**
 * OpenRouter price source. The public `/models` endpoint returns a `pricing`
 * object per model with USD-per-token strings (prompt/completion plus cache
 * read/write). No auth required; a key is used only if configured (avoids
 * rate limits).
 */
interface ORModel {
  id?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

export interface OpenRouterPriceSourceOpts {
  baseUrl?: string;
  apiKey?: string;
}

export class OpenRouterPriceSource implements PriceSource {
  readonly tag = 'openrouter' as const;

  constructor(private readonly opts: OpenRouterPriceSourceOpts = {}) {}

  async fetch(): Promise<NormalizedPrice[]> {
    const base = (this.opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    const r = await fetch(`${base}/models`, { headers });
    if (!r.ok) throw new Error(`OpenRouter pricing API error: HTTP ${r.status}`);
    const body = (await r.json()) as { data?: ORModel[] };

    const out: NormalizedPrice[] = [];
    for (const m of body.data ?? []) {
      if (!m.id || !m.pricing) continue;
      const input = perTokenToPerMtok(m.pricing.prompt);
      const output = perTokenToPerMtok(m.pricing.completion);
      if (input == null || output == null) continue; // can't price without both
      out.push({
        provider: '',
        rawModelId: m.id,
        normalizedModelId: normalizeModelId(m.id),
        input_per_mtok: input,
        output_per_mtok: output,
        cache_read_per_mtok: perTokenToPerMtok(m.pricing.input_cache_read),
        cache_write_per_mtok: perTokenToPerMtok(m.pricing.input_cache_write),
        currency: 'USD',
      });
    }
    return out;
  }
}
