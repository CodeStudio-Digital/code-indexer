/**
 * OpenRouter live model discovery (rich catalog).
 *
 * The OpenRouter catalog is richer than the basic OpenAI `/models` shape: it
 * exposes context window, modalities, top-provider output limits and the set
 * of supported OpenAI-compatible parameters.
 *
 * `spec` is unused beyond the signature except for `spec.discovery.modelsUrl`,
 * which overrides the derived endpoint when set. The base URL otherwise comes
 * from `cfg.base_url` (default `https://openrouter.ai/api/v1`).
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
  reasoning?: {
    supported_efforts?: string[] | null;
    default_effort?: string | null;
    default_enabled?: boolean | null;
    supports_max_tokens?: boolean | null;
    mandatory?: boolean | null;
  } | null;
  expiration_date?: string | null;
}

const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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
    const canReason =
      m.reasoning != null
      || supported.has('reasoning')
      || supported.has('include_reasoning');
    const reasoningLevels = canReason ? openrouterReasoningLevels(m.reasoning) : null;
    const defaultReasoningLevel = canReason
      ? normalizeReasoningLevel(m.reasoning?.default_effort)
        ?? (m.reasoning?.default_enabled === false ? 'none' : null)
      : null;
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
      supported_reasoning_levels: reasoningLevels,
      default_reasoning_level: defaultReasoningLevel,
      supported_in_api: true,
      visibility: m.expiration_date ? 'deprecated' : 'list',
      input_modalities: inputModalities,
      source: 'live' as const,
    });
  }
  return out;
}

function openrouterReasoningLevels(
  reasoning: OpenRouterModel['reasoning'],
): string[] {
  const advertised = reasoning?.supported_efforts;
  const levels = Array.isArray(advertised)
    ? advertised
        .map(normalizeReasoningLevel)
        .filter((value): value is string => value != null)
    : [...REASONING_LEVELS];
  const unique = [...new Set(levels)];
  return reasoning?.mandatory === true
    ? unique.filter((level) => level !== 'none')
    : unique;
}

function normalizeReasoningLevel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return REASONING_LEVELS.includes(normalized as (typeof REASONING_LEVELS)[number])
    ? normalized
    : null;
}

function validPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}
