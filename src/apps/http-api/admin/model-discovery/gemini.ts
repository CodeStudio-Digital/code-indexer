/**
 * Google Gemini model discovery via the public generativelanguage API.
 */
import type { ProviderConfig, UpsertModelInput } from '../../../../store/provider-store.js';

type GeminiModel = {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

export async function discoverGemini(cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  const { api_key } = cfg;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(api_key ?? '')}`
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { models: GeminiModel[] };
  return data.models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') ?? true)
    .map((m) => ({
      model_id: m.name.replace(/^models\//, ''),
      name: m.displayName ?? m.name,
      context_window: m.inputTokenLimit ?? null,
      default_max_tokens: m.outputTokenLimit ?? null,
      source: 'live' as const,
    }));
}
