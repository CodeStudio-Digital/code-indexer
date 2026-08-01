/**
 * sdk:copilot live model discovery.
 *
 * GitHub Copilot discovery:
 *  1. Refresh the short-lived Copilot token (~25min TTL). The api_key mirror on
 *     provider_configs is a fallback for the common case where the token is
 *     still valid.
 *  2. Hit the published /models endpoint with the header set the API requires.
 *     Prefer endpoints.api from the token exchange when present (the only way
 *     enterprise instances advertise their edge).
 *
 * This format THROWS on failure (no seed/empty fallback) — preserved verbatim.
 * `spec` is unused beyond the uniform signature.
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';
import {
  refreshIfExpired,
  copilotHeaders,
  getStoredCopilotOpts,
} from '@mcp/services/services/oauth/copilot.js';
import { resolveCopilotApiBase } from '@apps/http-api/admin/shared/copilot-opts.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

export async function discoverCopilotModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  store: ProviderStore,
): Promise<UpsertModelInput[]> {
  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshIfExpired(store, cfg.id);
    if (fresh) token = fresh;
  } catch (e) {
    throw new Error(
      `Copilot token refresh failed: ${(e as Error).message}. ` +
        `Re-connect Copilot in the admin UI.`
    );
  }
  if (!token) {
    throw new Error('No Copilot token. Click "Connect Copilot" to start the device flow.');
  }

  const opts = getStoredCopilotOpts(store, cfg.id);
  const base = resolveCopilotApiBase(store, cfg);
  const url = `${base}/models`;
  const r = await fetch(url, { headers: copilotHeaders(token, opts) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Copilot /models HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = (await r.json()) as { data: CopilotCatalogModel[] };
  return data.data.map(mapCopilotModel);
}

interface CopilotCatalogModel {
  id: string;
  name?: string;
  model_picker_enabled?: boolean;
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    supports?: {
      vision?: boolean;
      reasoning?: boolean;
    };
  };
}

export function mapCopilotModel(m: CopilotCatalogModel): UpsertModelInput {
  const meta = copilotReasoningMetadata(m.id);
  const limits = m.capabilities?.limits;
  const supportsVision = m.capabilities?.supports?.vision ?? isCopilotMultimodal(m.id);
  const canReason = m.capabilities?.supports?.reasoning ?? meta.canReason;
  return {
    model_id: m.id,
    name: m.name ?? m.id,
    display_name: m.name ?? m.id,
    context_window:
      limits?.max_context_window_tokens
      ?? limits?.max_prompt_tokens
      ?? getRegistryContextWindow(m.id),
    default_max_tokens: limits?.max_output_tokens ?? null,
    can_reason: canReason,
    supports_attachments: supportsVision,
    supported_reasoning_levels: canReason ? meta.levels : null,
    default_reasoning_level: canReason ? meta.defaultLevel : null,
    input_modalities: supportsVision ? ['text', 'image'] : ['text'],
    visibility: m.model_picker_enabled === false ? 'hidden' : 'list',
    supported_in_api: true,
    source: 'live' as const,
  };
}

function copilotReasoningMetadata(model: string): {
  canReason: boolean;
  levels: string[] | null;
  defaultLevel: string | null;
} {
  const id = model.toLowerCase();
  if (/^gemini-3\.6-flash(?:-|$)/.test(id)) {
    return {
      canReason: true,
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'medium',
    };
  }
  const configurable =
    /^gpt-5\.(?:3-codex|4|5|6)(?:-|$)/.test(id)
    || /^claude-(?:fable-5|sonnet-(?:4\.6|5)|opus-(?:4\.[678]|5))(?:-|$)/.test(id);
  if (configurable) {
    return {
      canReason: true,
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
    };
  }
  const fixed =
    /(?:^|[-/])o[134](?:-|$)/.test(id)
    || /(?:^|[-/])gemini-3(?:[.-]|$)/.test(id)
    || /(?:^|[-/])kimi-k2\.7(?:-|$)/.test(id);
  return { canReason: fixed, levels: null, defaultLevel: null };
}

function isCopilotMultimodal(model: string): boolean {
  return /(?:gpt-5|claude|gemini|kimi-k2\.7)/i.test(model);
}
