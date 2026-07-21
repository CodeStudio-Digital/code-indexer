import type { UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

export const KIMI_CODE_BASE_URL =
  process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1';

export const KIMI_CODE_SEED_MODELS = [
  seed('k3', 'Kimi K3', 1_048_576, 'Kimi flagship coding model with low, high, and max reasoning effort.'),
  seed('kimi-k2.6', 'Kimi K2.6', 262_144, 'Kimi Code default model for coding/v1 with thinking, image input, and video input.'),
  seed('kimi-k2.5', 'Kimi K2.5', 262_144, 'Kimi Code K2.5 model with thinking, image input, and video input.'),
  seed('kimi-k2-thinking', 'Kimi K2 Thinking', 262_144, 'Kimi Code thinking model. always_thinking.'),
  seed('kimi-k2-thinking-turbo', 'Kimi K2 Thinking Turbo', 262_144, 'Kimi Code fast thinking model. always_thinking.'),
  seed('kimi-k2-turbo-preview', 'Kimi K2 Turbo Preview', 262_144, 'Kimi Code K2 turbo preview model with thinking, image input, and video input.'),
] as const;

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
    const hasK2Defaults = isKimiK2(id);
    const hasK3Defaults = isKimiK3(id);
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
      context_window: model.context_length ?? (hasK3Defaults ? 1_048_576 : getRegistryContextWindow(id)),
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
  });
}

export function kimiCodeSeedUpsertModels(): UpsertModelInput[] {
  return KIMI_CODE_SEED_MODELS.map((model) => ({
    ...model,
    supported_reasoning_levels: isKimiK3(model.model_id)
      ? ['low', 'high', 'max']
      : ['low', 'medium', 'high'],
    default_reasoning_level: isKimiK3(model.model_id) ? 'max' : 'high',
    input_modalities: ['text', 'image', 'video'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  }));
}

function seed(
  model_id: string,
  name: string,
  context_window: number,
  description: string,
) {
  return {
    model_id,
    name,
    display_name: name,
    context_window,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description,
  };
}

function isKimiK2(id: string): boolean {
  return /^kimi-k2/i.test(id);
}

function isKimiK3(id: string): boolean {
  return /^k3$/i.test(id);
}
