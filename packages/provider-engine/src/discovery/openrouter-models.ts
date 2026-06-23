/**
 * OpenRouter live model discovery (rich catalog).
 *
 * Lifted verbatim from `apps/http-api/admin/model-discovery/openrouter.ts` so
 * the declarative spec path produces an IDENTICAL `UpsertModelInput[]`. The
 * OpenRouter catalog is richer than the basic OpenAI `/models` shape: it
 * exposes context window, modalities, top-provider output limits and the set
 * of supported OpenAI-compatible parameters.
 *
 * `spec` is unused beyond the signature except for `spec.discovery.modelsUrl`,
 * which overrides the derived endpoint when set. The base URL otherwise comes
 * from `cfg.base_url` (default `https://openrouter.ai/api/v1`), exactly as the
 * admin discoverX derives it.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

interface OpenRouterModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
  } | null;
  supported_parameters?: string[];
  expiration_date?: string | null;
}

const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export async function discoverOpenrouterModels(
  spec: ProviderSpec,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
  const base = (cfg.base_url ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const url = spec.discovery?.modelsUrl ?? `${base}/models?output_modalities=text`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.api_key ?? ''}` },
  });
  if (!r.ok) throw new Error(`OpenRouter API error: HTTP ${r.status}`);

  const body = (await r.json()) as { data?: OpenRouterModel[] };
  const out: UpsertModelInput[] = [];
  for (const m of body.data ?? []) {
    const id = m.id;
    if (!id) continue;

    const inputModalities = m.architecture?.input_modalities ?? ['text'];
    const outputModalities = m.architecture?.output_modalities ?? ['text'];
    if (outputModalities.length > 0 && !outputModalities.includes('text')) continue;

    const supported = new Set(m.supported_parameters ?? []);
    const canReason = supported.has('reasoning') || supported.has('include_reasoning');
    const supportsAttachments = inputModalities.some((modality) => modality !== 'text');
    const contextWindow = validPositiveInt(m.context_length)
      ?? validPositiveInt(m.top_provider?.context_length);

    out.push({
      model_id: id,
      name: m.name ?? id,
      display_name: m.name ?? null,
      description: m.description ?? null,
      context_window: contextWindow,
      default_max_tokens: validPositiveInt(m.top_provider?.max_completion_tokens),
      can_reason: canReason,
      supports_attachments: supportsAttachments,
      supported_reasoning_levels: canReason ? [...REASONING_LEVELS] : null,
      supported_in_api: true,
      visibility: m.expiration_date ? 'deprecated' : 'list',
      input_modalities: inputModalities,
      source: 'live' as const,
    });
  }
  return out;
}

function validPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}
