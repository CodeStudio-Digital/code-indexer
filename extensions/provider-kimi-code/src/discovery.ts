import type {
  ProviderDiscoverModelsContext,
  ProviderDiscoveredModel,
  ProviderDiscoveryResult,
} from '@mcp/provider-sdk';
import { KIMI_CODE_BASE_URL } from './spec.js';

export const KIMI_CODE_SEED_MODELS: ProviderDiscoveredModel[] = [
  seedK3('k3', 'Kimi K3', 1_048_576, true),
  seedK3('k3-256k', 'Kimi K3 256K', 262_144, false),
  seedCodingAlias('kimi-for-coding', 'Kimi for Coding'),
  seedCodingAlias('kimi-for-coding-highspeed', 'Kimi for Coding High-speed'),
];

interface KimiCodeModelInfo {
  id: string;
  display_name?: string;
  context_length?: number;
  supports_reasoning?: boolean;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
}

export async function discoverKimiCodeModels(
  ctx: ProviderDiscoverModelsContext,
): Promise<ProviderDiscoveryResult> {
  const base = (ctx.creds.baseURL ?? ctx.config.base_url ?? KIMI_CODE_BASE_URL).replace(/\/$/, '');
  const response = await ctx.fetch(`${base}/models`, {
    headers: {
      ...ctx.creds.extraHeaders,
      Authorization: `Bearer ${ctx.creds.apiKey ?? ''}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { data?: KimiCodeModelInfo[]; models?: KimiCodeModelInfo[] };
  const models = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return { models: models.map(mapKimiCodeModel), etag: null, notModified: false };
}

export function kimiCodeSeedUpsertModels(): ProviderDiscoveredModel[] {
  return KIMI_CODE_SEED_MODELS.map((model) => ({ ...model }));
}

export function mapKimiCodeModel(model: KimiCodeModelInfo): ProviderDiscoveredModel {
  const id = model.id;
  const hasK3Defaults = /^k3(?:-|$)/i.test(id);
  const hasCodingAliasDefaults = /^kimi-for-coding(?:-highspeed)?$/i.test(id);
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
    || (hasK3Defaults && !/^k3-256k$/i.test(id));
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
      ?? (/^k3-256k$/i.test(id)
        ? 262_144
        : hasK3Defaults
          ? 1_048_576
          : hasCodingAliasDefaults || hasLegacyK2Defaults
            ? 262_144
            : null),
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
}

function seedK3(
  model_id: string,
  name: string,
  context_window: number,
  supportsVideo: boolean,
): ProviderDiscoveredModel {
  return {
    model_id,
    name,
    display_name: name,
    description: `Kimi K3 coding model with low, high, and max reasoning effort; ${supportsVideo ? 'image and video' : 'image'} input.`,
    context_window,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    supported_reasoning_levels: ['low', 'high', 'max'],
    default_reasoning_level: 'high',
    input_modalities: supportsVideo ? ['text', 'image', 'video'] : ['text', 'image'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  };
}

function seedCodingAlias(model_id: string, name: string): ProviderDiscoveredModel {
  return {
    model_id,
    name,
    display_name: name,
    description: 'Kimi Code K2.7 coding alias with thinking, image input, and video input.',
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    supported_reasoning_levels: null,
    default_reasoning_level: null,
    input_modalities: ['text', 'image', 'video'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  };
}
