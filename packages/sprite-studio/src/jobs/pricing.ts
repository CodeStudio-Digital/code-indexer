/**
 * Cost estimation for image generation jobs (freemium metering ledger).
 *
 * APPROXIMATIONS by model FAMILY, checked against public list prices
 * (2026-07). Exact billing lives with the provider; this feeds the
 * `cost_usd` column so the UI can show running spend, nothing more.
 * - gpt-image-*: per-image flat table by quality x size; when the provider
 *   reports token usage we prefer usage-based math (~$10/1M input tokens,
 *   ~$40/1M output image tokens).
 * - dall-e-3: $0.04 (standard 1024x1024).
 * - Gemini PRO image family (gemini-3-pro-image / nano banana pro): ~$0.14
 *   per 1K/2K image (image tokens + thinking bill on top of flash rates —
 *   this is a PREMIUM model; drafts belong on the flash tier).
 * - Gemini flash image family (…-flash-image, imagen, nano banana 2):
 *   ~$0.039/image.
 * - Anything else (cloudflare flux, comfyui, unknown): $0.02 placeholder.
 */

type GptQuality = 'low' | 'medium' | 'high';

const GPT_IMAGE_PER_IMAGE: Record<GptQuality, Record<string, number>> = {
  low: { '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 },
  medium: { '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 },
  high: { '1024x1024': 0.167, '1024x1536': 0.25, '1536x1024': 0.25 },
};

const GPT_IMAGE_USD_PER_M_INPUT = 10;
const GPT_IMAGE_USD_PER_M_OUTPUT = 40;
const DALLE_PER_IMAGE = 0.04;
const GEMINI_IMAGE_PER_IMAGE = 0.039;
const GEMINI_PRO_IMAGE_PER_IMAGE = 0.14;
const DEFAULT_PER_IMAGE = 0.02;

const GEMINI_IMAGE_RE = /-image(-|$)|imagen|nano-banana/i;
/** gemini-3-pro-image*, nano-banana-pro — the premium reasoning image tier. */
const GEMINI_PRO_IMAGE_RE = /(gemini-[\d.]+-pro-image|nano-banana-pro|-pro-image)/i;

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export interface ImageUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Estimate the USD cost of `n` generated images. `usage` (when the provider
 * reported tokens) beats the flat table for the gpt-image family; unknown
 * sizes fall back to the 1024x1024 column, unknown quality to 'medium'.
 */
export function estimateCost(
  model: string,
  n: number,
  size?: string,
  quality?: string,
  usage?: ImageUsage | null,
): number {
  const count = Math.max(1, Math.floor(n) || 1);

  if (/^gpt-image/i.test(model)) {
    if (usage && ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0)) {
      return round6(
        ((usage.inputTokens ?? 0) * GPT_IMAGE_USD_PER_M_INPUT +
          (usage.outputTokens ?? 0) * GPT_IMAGE_USD_PER_M_OUTPUT) /
          1_000_000,
      );
    }
    const q: GptQuality =
      quality === 'low' || quality === 'high' ? quality : 'medium';
    const table = GPT_IMAGE_PER_IMAGE[q];
    return round6(count * (table[size ?? ''] ?? table['1024x1024']));
  }

  if (/^dall-e/i.test(model)) return round6(count * DALLE_PER_IMAGE);
  if (GEMINI_PRO_IMAGE_RE.test(model)) return round6(count * GEMINI_PRO_IMAGE_PER_IMAGE);
  if (GEMINI_IMAGE_RE.test(model)) return round6(count * GEMINI_IMAGE_PER_IMAGE);
  return round6(count * DEFAULT_PER_IMAGE);
}

/** Flat per-image estimate for a model (UI hints — the picker's cost badge). */
export function estimatePerImage(model: string): number {
  return estimateCost(model, 1);
}
