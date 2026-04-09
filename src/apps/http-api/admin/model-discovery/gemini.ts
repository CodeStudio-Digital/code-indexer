/**
 * Google Gemini model discovery via the public generativelanguage API.
 */
import type { ProviderConfig, UpsertModelInput } from '../../../../store/provider-store.js';

export async function discoverGemini(cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  const { api_key } = cfg;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(api_key ?? '')}`
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { models: { name: string; displayName?: string }[] };
  return data.models.map((m) => ({
    model_id: m.name.replace(/^models\//, ''),
    name: m.displayName ?? m.name,
    source: 'live',
  }));
}
