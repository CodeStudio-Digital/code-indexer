/**
 * Live model discovery for the `sdk:google-oauth` format.
 *
 * Lifted verbatim from the hand-written admin helper
 * `apps/http-api/admin/model-discovery/google-oauth.ts` (`discoverGoogleOAuth`).
 * The behaviour is identical — the equivalence test asserts deep equality of
 * the returned `UpsertModelInput[]`.
 *
 * Google Gemini model discovery via OAuth Bearer token (instead of API key):
 * the token is refreshed through `refreshIfExpired(store, cfg.id)` (falling back
 * to the stale `api_key` token on failure), then `/v1beta/models` is fetched and
 * filtered to `generateContent`-capable entries. `spec` is part of the signature
 * for uniformity but unused here (the URL/auth are fixed).
 */
import type { ProviderStore, ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { refreshIfExpired } from '@mcp/services/services/oauth/google.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

type GeminiModel = {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

export async function discoverGoogleOAuthModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  store: ProviderStore,
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
