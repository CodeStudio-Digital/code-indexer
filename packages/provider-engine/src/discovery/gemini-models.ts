/**
 * Live model-discovery for the `gemini-models` format.
 *
 * Uses the Google generativelanguage endpoint and passes the api key as a
 * `?key=` query param (no auth header). Only the optional `modelsUrl` override
 * is read from `spec.discovery` (the rest of the descriptor — filterPrefixes /
 * supportsModes / accountIdFrom — does not apply to this format).
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import type { ProviderSpec } from '@mcp/provider-sdk';
import { isGeminiImageModelId, IMAGE_MODEL_MODE } from './image-model-ids.js';

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
    .map((m) => {
      const id = m.name.replace(/^models\//, '');
      const reasoning = geminiReasoningMetadata(id);
      return {
        model_id: id,
        name: m.displayName ?? m.name,
        display_name: m.displayName ?? m.name,
        context_window: m.inputTokenLimit ?? null,
        default_max_tokens: m.outputTokenLimit ?? null,
        can_reason: reasoning != null,
        supported_reasoning_levels: reasoning?.levels ?? null,
        default_reasoning_level: reasoning?.defaultLevel ?? null,
        supports_attachments: !isGeminiImageModelId(id),
        input_modalities: isGeminiImageModelId(id)
          ? ['text', 'image']
          : ['text', 'image', 'audio', 'video'],
        visibility: 'list' as const,
        supported_in_api: true,
        source: 'live' as const,
        // Family-based tagging (gemini-*-image*, imagen-*, nano banana) so
        // image models surface in the image-role pickers.
        ...(isGeminiImageModelId(id) ? { mode: IMAGE_MODEL_MODE } : {}),
      };
    });
}

export function geminiReasoningMetadata(
  model: string,
): { levels: string[]; defaultLevel: string } | null {
  const id = model.toLowerCase();
  if (/^gemini-3\.1-pro/.test(id)) {
    return { levels: ['low', 'medium', 'high'], defaultLevel: 'high' };
  }
  if (/^gemini-3\.(?:1|5)-flash-lite/.test(id)) {
    return { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'minimal' };
  }
  if (/^gemini-3\.(?:5|6)-flash/.test(id)) {
    return { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'medium' };
  }
  if (/^gemini-3(?:-|$)/.test(id)) {
    return { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'high' };
  }
  if (/^gemini-2\.5-pro/.test(id)) {
    return { levels: ['low', 'medium', 'high'], defaultLevel: 'high' };
  }
  if (/^gemini-2\.5-flash/.test(id)) {
    return { levels: ['none', 'low', 'medium', 'high'], defaultLevel: 'medium' };
  }
  return null;
}
