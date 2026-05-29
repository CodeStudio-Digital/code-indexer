import type { NormalizedPrice, PriceSource } from './types.js';
import { normalizeModelId, perTokenToPerMtok } from './normalize.js';

/**
 * LiteLLM price source. BerriAI publishes a community-maintained JSON keyed
 * by model name with direct-provider list prices (USD per token, as numbers)
 * including cache read/write. It's the most comprehensive source and tracks
 * what you pay calling providers directly — so it outranks OpenRouter.
 */
interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
}

// Non-text-generation rows we don't price here (embeddings/rerank/etc are a
// separate epic). Rows without a mode are kept (most chat models omit it).
const SKIP_MODES = new Set([
  'embedding',
  'image_generation',
  'audio_transcription',
  'audio_speech',
  'rerank',
  'moderation',
]);

const DEFAULT_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export class LiteLLMPriceSource implements PriceSource {
  readonly tag = 'litellm' as const;

  constructor(private readonly url: string = DEFAULT_URL) {}

  async fetch(): Promise<NormalizedPrice[]> {
    const r = await fetch(this.url);
    if (!r.ok) throw new Error(`LiteLLM pricing fetch error: HTTP ${r.status}`);
    const body = (await r.json()) as Record<string, LiteLLMEntry>;

    const out: NormalizedPrice[] = [];
    for (const [key, e] of Object.entries(body)) {
      if (key === 'sample_spec') continue; // documentation stub, not a model
      if (e.mode && SKIP_MODES.has(e.mode)) continue;
      const input = perTokenToPerMtok(e.input_cost_per_token);
      const output = perTokenToPerMtok(e.output_cost_per_token);
      if (input == null || output == null) continue;
      out.push({
        provider: '',
        rawModelId: key,
        normalizedModelId: normalizeModelId(key),
        input_per_mtok: input,
        output_per_mtok: output,
        cache_read_per_mtok: perTokenToPerMtok(e.cache_read_input_token_cost),
        cache_write_per_mtok: perTokenToPerMtok(e.cache_creation_input_token_cost),
        currency: 'USD',
      });
    }
    return out;
  }
}
