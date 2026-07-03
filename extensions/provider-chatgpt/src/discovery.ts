import { randomUUID } from 'node:crypto';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type {
  ProviderDiscoverModelsContext,
  ProviderDiscoveredModel,
  ProviderDiscoveryResult,
} from '@mcp/provider-sdk';
import { CHATGPT_CODEX_BASE_URL } from './auth.js';

const REQUEST_TIMEOUT_MS = 5_000;
const CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION ?? '999.0.0';

export const CHATGPT_SEED_MODELS: Array<{
  model_id: string;
  name: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: string[];
  apply_patch_tool_type?: string;
}> = [
  {
    model_id: 'gpt-5.4',
    name: 'GPT-5.4',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    model_id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    model_id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    model_id: 'gpt-5.2',
    name: 'GPT-5.2',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    model_id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    model_id: 'gpt-5.1-codex',
    name: 'GPT-5.1 Codex',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    model_id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Codex max',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    model_id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex mini',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  },
];

interface CodexModelInfo {
  slug: string;
  display_name?: string;
  description?: string;
  context_window?: number;
  max_context_window?: number;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown[];
  apply_patch_tool_type?: string;
  available_in_plans?: string[];
  minimal_client_version?: string;
  visibility?: 'list' | 'hidden' | string;
  supported_in_api?: boolean;
  input_modalities?: string[];
}

interface CodexModelsResponse {
  models: CodexModelInfo[];
}

export async function discoverChatGPTModels(
  ctx: ProviderDiscoverModelsContext,
): Promise<ProviderDiscoveryResult> {
  const baseURL = (ctx.config.base_url ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, '');
  const accountId =
    typeof ctx.creds.extra?.accountId === 'string' && ctx.creds.extra.accountId.length > 0
      ? ctx.creds.extra.accountId
      : null;

  if (!ctx.creds.apiKey || !accountId) {
    ctx.log('missing access token or account id; using seed list');
    return { models: seedFallback(), etag: null, notModified: false };
  }

  const url = `${baseURL}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.creds.apiKey}`,
    'ChatGPT-Account-Id': accountId,
    originator: 'codex_cli_rs',
    'User-Agent': `codex_cli_rs/${CLIENT_VERSION}`,
    session_id: randomUUID(),
  };
  if (ctx.previousEtag) headers['If-None-Match'] = ctx.previousEtag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await ctx.fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    ctx.log(`model fetch failed: ${(err as Error).message}; using seed list`);
    return { models: seedFallback(), etag: null, notModified: false };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 304) {
    return { models: [], etag: ctx.previousEtag ?? null, notModified: true };
  }

  if (!response.ok) {
    ctx.log(`model fetch HTTP ${response.status}; using seed list`);
    return { models: seedFallback(), etag: null, notModified: false };
  }

  let data: CodexModelsResponse;
  try {
    data = (await response.json()) as CodexModelsResponse;
  } catch (err) {
    ctx.log(`invalid model JSON: ${(err as Error).message}; using seed list`);
    return { models: seedFallback(), etag: null, notModified: false };
  }

  const etag = response.headers.get('etag');
  return {
    models: (data.models ?? []).map(toUpsertInput),
    etag: etag && etag.length > 0 ? etag : null,
    notModified: false,
  };
}

function toUpsertInput(model: CodexModelInfo): ProviderDiscoveredModel {
  const isListed = model.visibility === undefined || model.visibility === 'list';
  const isApi = model.supported_in_api !== false;

  return {
    model_id: model.slug,
    name: model.display_name ?? model.slug,
    context_window: model.context_window ?? model.max_context_window ?? null,
    source: 'live',
    default_enabled: isListed && isApi,
    display_name: model.display_name ?? null,
    description: model.description ?? null,
    default_reasoning_level: normalizeReasoningLevel(model.default_reasoning_level),
    supported_reasoning_levels: normalizeReasoningLevels(model.supported_reasoning_levels),
    apply_patch_tool_type: model.apply_patch_tool_type ?? null,
    available_in_plans: model.available_in_plans ?? null,
    minimal_client_version: model.minimal_client_version ?? null,
    visibility: model.visibility ?? null,
    supported_in_api: model.supported_in_api ?? null,
    input_modalities: model.input_modalities ?? null,
  };
}

function normalizeReasoningLevel(level: unknown): string | null {
  if (typeof level === 'string') return level;
  if (level && typeof level === 'object' && 'effort' in level) {
    const effort = (level as Record<string, unknown>).effort;
    return typeof effort === 'string' ? effort : null;
  }
  return null;
}

function normalizeReasoningLevels(levels: unknown[] | undefined): string[] | null {
  if (!Array.isArray(levels)) return null;
  const result = levels.map(normalizeReasoningLevel).filter((v): v is string => Boolean(v));
  return result.length > 0 ? result : null;
}

function seedFallback(): ProviderDiscoveredModel[] {
  return CHATGPT_SEED_MODELS.map((model) => ({
    model_id: model.model_id,
    name: model.name,
    context_window: getRegistryContextWindow(model.model_id),
    source: 'live',
    default_reasoning_level: model.default_reasoning_level ?? null,
    supported_reasoning_levels: model.supported_reasoning_levels ?? null,
    apply_patch_tool_type: model.apply_patch_tool_type ?? null,
  }));
}
