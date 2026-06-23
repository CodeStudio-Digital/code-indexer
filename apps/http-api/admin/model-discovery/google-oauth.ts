/**
 * Google Gemini model discovery via OAuth Bearer token (instead of API key).
 */
import type { ProviderStore, ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { refreshIfExpired } from '@mcp/services/services/oauth/google.js';

type GeminiModel = {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

export async function discoverGoogleOAuth(
  store: ProviderStore,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshIfExpired(store, cfg.id);
    if (fresh) token = fresh;
  } catch { /* use stale token */ }

  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { Authorization: `Bearer ${token}` },
  });
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
