/**
 * ChatGPT (Codex backend) model discovery.
 *
 * The Codex backend exposes `/models` to OAuth tokens. The same endpoint
 * is used by the official Codex CLI (codex-rs/model-provider/src/models_endpoint.rs)
 * with ETag-based revalidation:
 *
 *   GET {base}/models?client_version={v}
 *   Authorization:   Bearer {access_token}
 *   ChatGPT-Account-Id: {account_id from id_token}
 *   originator: codex_cli_rs
 *   User-Agent: codex_cli_rs/{v}
 *   session_id: {uuid}
 *   If-None-Match: {previous_etag?}
 *
 * Response: { models: ModelInfo[] } with `ETag` header.
 *
 * Falls back to the hardcoded {@link CHATGPT_SEED_MODELS} list on network
 * error / 5xx / timeout so a flaky upstream doesn't wipe a working catalog.
 */
import { randomUUID } from 'node:crypto';
import type { ProviderConfig, UpsertModelInput } from '../../../../store/provider-store.js';
import {
  CHATGPT_SEED_MODELS,
  CHATGPT_CODEX_BASE_URL,
} from '../../../../core/services/oauth/openai.js';
import { resolveChatGPTCreds } from '../../../../core/providers/shared/oauth.js';
import { getRegistryContextWindow } from '../../../../core/coder/providers/capabilities.js';
import type { DiscoveryResult } from './index.js';

const REQUEST_TIMEOUT_MS = 5_000;

const CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION ?? '999.0.0';

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

export async function discoverChatgpt(
  cfg: ProviderConfig,
  previousEtag?: string | null,
): Promise<DiscoveryResult> {
  const baseURL = (cfg.base_url ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, '');

  let creds: Awaited<ReturnType<typeof resolveChatGPTCreds>>;
  try {
    creds = await resolveChatGPTCreds(cfg);
  } catch (err) {
    console.warn(`[chatgpt-discovery] could not resolve creds: ${(err as Error).message}`);
    return { models: seedFallback(), etag: null, notModified: false };
  }

  const accountId =
    typeof creds.extra?.accountId === 'string' && creds.extra.accountId.length > 0
      ? creds.extra.accountId
      : null;

  if (!creds.apiKey || !accountId) {
    console.warn('[chatgpt-discovery] missing access token or account id; using seed list');
    return { models: seedFallback(), etag: null, notModified: false };
  }

  const url = `${baseURL}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.apiKey}`,
    'ChatGPT-Account-Id': accountId,
    originator: 'codex_cli_rs',
    'User-Agent': `codex_cli_rs/${CLIENT_VERSION}`,
    session_id: randomUUID(),
  };
  if (previousEtag) headers['If-None-Match'] = previousEtag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    console.warn(`[chatgpt-discovery] fetch failed: ${(err as Error).message}; using seed list`);
    return { models: seedFallback(), etag: null, notModified: false };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 304) {
    return { models: [], etag: previousEtag ?? null, notModified: true };
  }

  if (!response.ok) {
    console.warn(
      `[chatgpt-discovery] HTTP ${response.status}; using seed list (body=${(await response.text()).slice(0, 200)})`,
    );
    return { models: seedFallback(), etag: null, notModified: false };
  }

  let data: CodexModelsResponse;
  try {
    data = (await response.json()) as CodexModelsResponse;
  } catch (err) {
    console.warn(`[chatgpt-discovery] invalid JSON: ${(err as Error).message}; using seed list`);
    return { models: seedFallback(), etag: null, notModified: false };
  }

  const models = (data.models ?? []).map(toUpsertInput);
  const etag = response.headers.get('etag');
  return { models, etag: etag && etag.length > 0 ? etag : null, notModified: false };
}

function toUpsertInput(m: CodexModelInfo): UpsertModelInput {
  const isListed = m.visibility === undefined || m.visibility === 'list';
  const isApi = m.supported_in_api !== false;

  return {
    model_id: m.slug,
    name: m.display_name ?? m.slug,
    context_window: m.context_window ?? m.max_context_window ?? null,
    source: 'live',
    // Default disabled for hidden / non-API models on first sight. Admin
    // toggles via PATCH /providers/:id/models/:modelId override this and
    // are preserved across refreshes by `replaceModelsFromSource`.
    default_enabled: isListed && isApi,
    display_name: m.display_name ?? null,
    description: m.description ?? null,
    default_reasoning_level: normalizeReasoningLevel(m.default_reasoning_level),
    supported_reasoning_levels: normalizeReasoningLevels(m.supported_reasoning_levels),
    apply_patch_tool_type: m.apply_patch_tool_type ?? null,
    available_in_plans: m.available_in_plans ?? null,
    minimal_client_version: m.minimal_client_version ?? null,
    visibility: m.visibility ?? null,
    supported_in_api: m.supported_in_api ?? null,
    input_modalities: m.input_modalities ?? null,
  };
}

function normalizeReasoningLevel(lv: unknown): string | null {
  if (typeof lv === 'string') return lv;
  if (lv && typeof lv === 'object' && 'effort' in lv && typeof (lv as Record<string, unknown>).effort === 'string') {
    return (lv as Record<string, unknown>).effort as string;
  }
  return null;
}

function normalizeReasoningLevels(levels: unknown[] | undefined): string[] | null {
  if (!Array.isArray(levels)) return null;
  const result: string[] = [];
  for (const lv of levels) {
    const s = normalizeReasoningLevel(lv);
    if (s) result.push(s);
  }
  return result.length > 0 ? result : null;
}

function seedFallback(): UpsertModelInput[] {
  return CHATGPT_SEED_MODELS.map((m) => ({
    model_id: m.model_id,
    name: m.name,
    context_window: getRegistryContextWindow(m.model_id),
    source: 'live' as const,
  }));
}
