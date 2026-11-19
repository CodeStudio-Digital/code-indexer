/**
 * Live model discovery for the `anthropic-models` format.
 *
 * The Anthropic format takes no parameters from `spec.discovery` (the URL is
 * fixed at `/v1/models` and the base URL is derived from the provider row), so
 * `spec` is unused beyond the signature.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

export async function discoverAnthropicModels(
  spec: ProviderSpec,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
  const { api_key, base_url } = cfg;
  const base = (base_url ?? 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  const r = await fetch(`${base}/v1/models`, {
    headers: {
      'x-api-key': api_key ?? '',
      'anthropic-version': '2023-06-01',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  type CapabilitySupport = { supported?: boolean } | null;
  type AnthropicModelInfo = {
    id: string;
    display_name?: string;
    max_input_tokens?: number | null;
    max_tokens?: number | null;
    capabilities?: {
      effort?: {
        supported?: boolean;
        low?: CapabilitySupport;
        medium?: CapabilitySupport;
        high?: CapabilitySupport;
        xhigh?: CapabilitySupport;
        max?: CapabilitySupport;
      } | null;
      thinking?: {
        supported?: boolean;
        types?: {
          adaptive?: CapabilitySupport;
          enabled?: CapabilitySupport;
        } | null;
      } | null;
      image_input?: CapabilitySupport;
      pdf_input?: CapabilitySupport;
    } | null;
  };
  const data = (await r.json()) as { data: AnthropicModelInfo[] };
  const effortOrder = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  return data.data.map((m) => {
    const seed = spec.models?.[m.id];
    const effort = m.capabilities?.effort;
    const supportedReasoningLevels = effort?.supported
      ? effortOrder.filter((level) => effort[level]?.supported === true)
      : seed?.supportedReasoningLevels;
    const thinkingSupported =
      m.capabilities?.thinking?.supported === true ||
      m.capabilities?.thinking?.types?.adaptive?.supported === true ||
      m.capabilities?.thinking?.types?.enabled?.supported === true;
    const canReason =
      thinkingSupported || effort?.supported === true
        ? true
        : supportedReasoningLevels
          ? supportedReasoningLevels.length > 0
          : undefined;
    const contextWindow =
      typeof m.max_input_tokens === 'number' && m.max_input_tokens > 0
        ? m.max_input_tokens
        : seed?.contextWindow ?? getRegistryContextWindow(m.id);
    const maxTokens =
      typeof m.max_tokens === 'number' && m.max_tokens > 0
        ? m.max_tokens
        : seed?.maxTokens;
    const supportsAttachments =
      m.capabilities?.image_input?.supported === true ||
      m.capabilities?.pdf_input?.supported === true
        ? true
        : undefined;

    return {
      model_id: m.id,
      name: m.display_name ?? m.id,
      context_window: contextWindow,
      ...(maxTokens != null ? { default_max_tokens: maxTokens } : {}),
      ...(canReason !== undefined ? { can_reason: canReason } : {}),
      ...(supportsAttachments !== undefined ? { supports_attachments: supportsAttachments } : {}),
      // `!= null`, not `!== undefined`: the spec seed types this as
      // `string[] | null` (spec.ts — `.nullable().optional()` in the schema), and
      // a null seed carries the same "no information" meaning as a missing one.
      // Omitting the key matches how every other optional field in this map is
      // built (see `maxTokens != null` above) and keeps the spread type-safe.
      ...(supportedReasoningLevels != null
        ? { supported_reasoning_levels: [...supportedReasoningLevels] }
        : {}),
      ...(seed?.defaultReasoningLevel !== undefined
        ? { default_reasoning_level: seed.defaultReasoningLevel }
        : supportedReasoningLevels?.includes('high')
          ? {
              default_reasoning_level:
                m.id.includes('claude-opus-4-7') &&
                supportedReasoningLevels.includes('xhigh')
                  ? 'xhigh'
                  : 'high',
            }
          : {}),
      source: 'live' as const,
    };
  });
}
