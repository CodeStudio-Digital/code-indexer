import type { UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

export const KIMI_CODE_BASE_URL =
  process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1';

export const KIMI_CODE_SEED_MODELS: UpsertModelInput[] = [
  seedK3('k3', 'Kimi K3', 1_048_576, true),
  seedK3('k3-256k', 'Kimi K3 256K', 262_144, false),
  seedCodingAlias('kimi-for-coding', 'Kimi for Coding'),
  seedCodingAlias('kimi-for-coding-highspeed', 'Kimi for Coding High-speed'),
];

export interface KimiCodeModelInfo {
  id: string;
  display_name?: string;
  context_length?: number;
  supports_reasoning?: boolean;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
}

export async function fetchKimiCodeModels(opts: {
  baseURL?: string | null;
  apiKey?: string | null;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}): Promise<KimiCodeModelInfo[]> {
  const base = (opts.baseURL ?? KIMI_CODE_BASE_URL).replace(/\/$/, '');
  const response = await (opts.fetch ?? globalThis.fetch)(`${base}/models`, {
    headers: {
      ...opts.headers,
      Authorization: `Bearer ${opts.apiKey ?? ''}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as {
    data?: KimiCodeModelInfo[];
    models?: KimiCodeModelInfo[];
  };
  return Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
}

export function mapKimiCodeModels(models: KimiCodeModelInfo[]): UpsertModelInput[] {
  return models.map((model) => {
    const id = model.id;
    const hasK3Defaults = isKimiK3(id);
    const hasCodingAliasDefaults = isKimiCodingAlias(id);
    const hasLegacyK2Defaults = /^kimi-k2/i.test(id);
    const canReason =
      Boolean(model.supports_reasoning)
      || hasCodingAliasDefaults
      || hasLegacyK2Defaults
      || hasK3Defaults;
    const supportsImage =
      Boolean(model.supports_image_in)
      || hasCodingAliasDefaults
      || hasLegacyK2Defaults
      || hasK3Defaults;
    const supportsVideo =
      Boolean(model.supports_video_in)
      || hasCodingAliasDefaults
      || hasLegacyK2Defaults
      || (hasK3Defaults && !isKimiK3256k(id));
    const modalities = ['text'];
    if (supportsImage) modalities.push('image');
    if (supportsVideo) modalities.push('video');
    return {
      model_id: id,
      name: model.display_name ?? id,
      display_name: model.display_name ?? id,
      description: [
        'Kimi Code coding/v1 model',
        canReason ? 'thinking' : null,
        supportsImage ? 'image input' : null,
        supportsVideo ? 'video input' : null,
      ].filter(Boolean).join('; '),
      context_window:
        model.context_length
        ?? (isKimiK3256k(id)
          ? 262_144
          : hasK3Defaults
            ? 1_048_576
            : hasCodingAliasDefaults || hasLegacyK2Defaults
              ? 262_144
              : getRegistryContextWindow(id)),
      default_max_tokens:
        hasCodingAliasDefaults || hasLegacyK2Defaults || hasK3Defaults ? 32_000 : null,
      can_reason: canReason,
      supports_attachments: supportsImage || supportsVideo,
      default_reasoning_level: hasK3Defaults || hasLegacyK2Defaults ? 'high' : null,
      supported_reasoning_levels: hasK3Defaults
        ? ['low', 'high', 'max']
        : hasLegacyK2Defaults
          ? ['low', 'medium', 'high']
          : null,
      visibility: 'list',
      supported_in_api: true,
      input_modalities: modalities,
      source: 'live',
    };
  });
}

export function kimiCodeSeedUpsertModels(): UpsertModelInput[] {
  return KIMI_CODE_SEED_MODELS.map((model) => ({ ...model }));
}

function seedK3(
  model_id: string,
  name: string,
  context_window: number,
  supportsVideo: boolean,
) {
  return {
    model_id,
    name,
    display_name: name,
    context_window,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description: `Kimi K3 coding model with low, high, and max reasoning effort; ${supportsVideo ? 'image and video' : 'image'} input.`,
    supported_reasoning_levels: ['low', 'high', 'max'],
    default_reasoning_level: 'high',
    input_modalities: supportsVideo ? ['text', 'image', 'video'] : ['text', 'image'],
    visibility: 'list' as const,
    supported_in_api: true,
    source: 'seed' as const,
  };
}

function seedCodingAlias(model_id: string, name: string) {
  return {
    model_id,
    name,
    display_name: name,
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description: 'Kimi Code K2.7 coding alias with thinking, image input, and video input.',
    supported_reasoning_levels: null,
    default_reasoning_level: null,
    input_modalities: ['text', 'image', 'video'],
    visibility: 'list' as const,
    supported_in_api: true,
    source: 'seed' as const,
  };
}

function isKimiK3(id: string): boolean {
  return /^k3(?:-|$)/i.test(id);
}

function isKimiK3256k(id: string): boolean {
  return /^k3-256k$/i.test(id);
}

function isKimiCodingAlias(id: string): boolean {
  return /^kimi-for-coding(?:-highspeed)?$/i.test(id);
}
