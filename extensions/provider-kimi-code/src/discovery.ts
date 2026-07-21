import type {
  ProviderDiscoverModelsContext,
  ProviderDiscoveredModel,
  ProviderDiscoveryResult,
} from '@mcp/provider-sdk';
import { KIMI_CODE_BASE_URL } from './spec.js';

export const KIMI_CODE_SEED_MODELS: ProviderDiscoveredModel[] = [
  seedK3(),
  seed('kimi-k2.6', 'Kimi K2.6', 'Kimi Code default model for coding/v1 with thinking, image input, and video input.'),
  seed('kimi-k2.5', 'Kimi K2.5', 'Kimi Code K2.5 model with thinking, image input, and video input.'),
  seed('kimi-k2-thinking', 'Kimi K2 Thinking', 'Kimi Code thinking model. always_thinking.'),
  seed('kimi-k2-thinking-turbo', 'Kimi K2 Thinking Turbo', 'Kimi Code fast thinking model. always_thinking.'),
  seed('kimi-k2-turbo-preview', 'Kimi K2 Turbo Preview', 'Kimi Code K2 turbo preview model with thinking, image input, and video input.'),
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
  const hasK2Defaults = /^kimi-k2/i.test(id);
  const hasK3Defaults = /^k3$/i.test(id);
  const alwaysThinking = /thinking/i.test(id);
  const canReason = Boolean(model.supports_reasoning) || hasK2Defaults || hasK3Defaults || alwaysThinking;
  const supportsImage = Boolean(model.supports_image_in) || hasK2Defaults || hasK3Defaults;
  const supportsVideo = Boolean(model.supports_video_in) || hasK2Defaults || hasK3Defaults;
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
      alwaysThinking ? 'always_thinking' : null,
    ].filter(Boolean).join('; '),
    context_window: model.context_length ?? (hasK3Defaults ? 1_048_576 : hasK2Defaults ? 262_144 : null),
    default_max_tokens: hasK2Defaults || hasK3Defaults ? 32_000 : null,
    can_reason: canReason,
    supports_attachments: supportsImage || supportsVideo,
    default_reasoning_level: hasK3Defaults ? 'max' : canReason ? 'high' : null,
    supported_reasoning_levels: hasK3Defaults
      ? ['low', 'high', 'max']
      : canReason ? ['low', 'medium', 'high'] : null,
    visibility: 'list',
    supported_in_api: true,
    input_modalities: modalities,
    source: 'live',
  };
}

function seedK3(): ProviderDiscoveredModel {
  return {
    model_id: 'k3',
    name: 'Kimi K3',
    display_name: 'Kimi K3',
    description: 'Kimi flagship coding model with low, high, and max reasoning effort.',
    context_window: 1_048_576,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    supported_reasoning_levels: ['low', 'high', 'max'],
    default_reasoning_level: 'max',
    input_modalities: ['text', 'image', 'video'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  };
}

function seed(model_id: string, name: string, description: string): ProviderDiscoveredModel {
  return {
    model_id,
    name,
    display_name: name,
    description,
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    supported_reasoning_levels: ['low', 'medium', 'high'],
    default_reasoning_level: 'high',
    input_modalities: ['text', 'image', 'video'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  };
}
