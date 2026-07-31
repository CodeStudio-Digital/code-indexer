import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type {
  ProviderDiscoverModelsContext,
  ProviderDiscoveredModel,
  ProviderDiscoveryResult,
} from '@mcp/provider-sdk';
import { copilotHeaders, type CopilotOAuthOptions } from './auth.js';

export async function discoverCopilotModels(
  ctx: ProviderDiscoverModelsContext,
): Promise<ProviderDiscoveryResult> {
  const token = ctx.creds.apiKey ?? '';
  if (!token) throw new Error('No Copilot token. Connect Copilot in the admin UI.');

  const opts = readCopilotOpts(ctx.creds.extra?.copilotOpts);
  const base = (ctx.creds.baseURL ?? ctx.config.base_url ?? 'https://api.githubcopilot.com').replace(/\/$/, '');
  const response = await ctx.fetch(`${base}/models`, { headers: copilotHeaders(token, opts) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Copilot /models HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { data?: CopilotCatalogModel[] };
  return {
    models: (data.data ?? []).map(toUpsertInput),
    etag: null,
    notModified: false,
  };
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

function toUpsertInput(model: CopilotCatalogModel): ProviderDiscoveredModel {
  const meta = copilotReasoningMetadata(model.id);
  const limits = model.capabilities?.limits;
  const supportsVision = model.capabilities?.supports?.vision ?? isCopilotMultimodal(model.id);
  const canReason = model.capabilities?.supports?.reasoning ?? meta.canReason;
  return {
    model_id: model.id,
    name: model.name ?? model.id,
    display_name: model.name ?? model.id,
    context_window:
      limits?.max_context_window_tokens
      ?? limits?.max_prompt_tokens
      ?? getRegistryContextWindow(model.id),
    default_max_tokens: limits?.max_output_tokens ?? null,
    can_reason: canReason,
    supports_attachments: supportsVision,
    supported_reasoning_levels: canReason ? meta.levels : null,
    default_reasoning_level: canReason ? meta.defaultLevel : null,
    input_modalities: supportsVision ? ['text', 'image'] : ['text'],
    visibility: model.model_picker_enabled === false ? 'hidden' : 'list',
    supported_in_api: true,
    source: 'live',
  };
}

function copilotReasoningMetadata(model: string): {
  canReason: boolean;
  levels: string[] | null;
  defaultLevel: string | null;
} {
  const id = model.toLowerCase();
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

function readCopilotOpts(value: unknown): CopilotOAuthOptions {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const opts = value as Partial<CopilotOAuthOptions>;
    if (opts.edition === 'enterprise') {
      return {
        edition: 'enterprise',
        ghes_host: opts.ghes_host,
        integration_id: opts.integration_id,
        client_id: opts.client_id,
      };
    }
  }
  return { edition: 'individual' };
}
