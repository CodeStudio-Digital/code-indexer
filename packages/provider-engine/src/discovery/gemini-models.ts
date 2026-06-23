/**
 * Live model-discovery for the `gemini-models` format.
 *
 * Declarative lift of the hand-written admin discoverer at
 * `apps/http-api/admin/model-discovery/gemini.ts`. The output
 * (`UpsertModelInput[]`) is asserted byte-for-byte identical by
 * `__tests__/discovery-gemini-models.test.ts`.
 *
 * The admin function hardcodes the Google generativelanguage endpoint and
 * passes the api key as a `?key=` query param (no auth header). We reproduce
 * that exactly; only the optional `modelsUrl` override is read from
 * `spec.discovery` (the rest of the descriptor — filterPrefixes / supportsModes
 * / accountIdFrom — does not apply to this format).
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

type GeminiModel = {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

const DEFAULT_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function discoverGeminiModels(
  spec: ProviderSpec,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
  const { api_key } = cfg;
  const base = spec.discovery?.modelsUrl ?? DEFAULT_MODELS_URL;
  const r = await fetch(`${base}?key=${encodeURIComponent(api_key ?? '')}`);
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
