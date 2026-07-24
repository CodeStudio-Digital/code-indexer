/**
 * Live model discovery for the `chatgpt-models` format (Codex backend, ETag).
 *
 * This is the sole ETag/304 producer, so it returns a full `DiscoveryResult`
 * (not a bare `UpsertModelInput[]`) and takes `previousEtag` directly. The
 * Codex backend exposes `/models` to OAuth tokens with ETag-based revalidation
 * (same contract as the official Codex CLI). It falls back to the hardcoded
 * {@link CHATGPT_SEED_MODELS} list on creds-resolve failure / missing creds /
 * network error / 5xx / timeout / invalid JSON so a flaky upstream doesn't wipe
 * a working catalog.
 *
 * `spec` is part of the signature for uniformity with the other format
 * builders but is unused (the URL is derived from the provider row + the fixed
 * Codex base), hence `_spec`.
 */
import { randomUUID } from 'node:crypto';
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import {
  CHATGPT_SEED_MODELS,
  CHATGPT_CODEX_BASE_URL,
} from '@mcp/services/services/oauth/openai.js';
import { resolveChatGPTCreds } from '@mcp/services/providers/shared/oauth.js';
import { nativeReasoningLevel, nativeReasoningLevels, type ProviderSpec } from '@mcp/provider-sdk';
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

export async function discoverChatgptModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  previousEtag: string | null,
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
  const defaultReasoningLevel = nativeReasoningLevel(normalizeReasoningLevel(m.default_reasoning_level));
  const supportedReasoningLevels = normalizeReasoningLevels(m.supported_reasoning_levels);

  return {
    model_id: m.slug,
    name: m.display_name ?? m.slug,
    context_window: m.context_window ?? m.max_context_window ?? null,
    source: 'live',
    // Visibility controls the Codex product surface. `supported_in_api`
    // describes the separate public OpenAI API and must not disable listed
    // Codex-only models such as gpt-5.3-codex-spark.
    default_enabled: isListed,
    display_name: m.display_name ?? null,
    description: m.description ?? null,
    can_reason: defaultReasoningLevel !== null || supportedReasoningLevels !== null,
    default_reasoning_level: defaultReasoningLevel,
    supported_reasoning_levels: supportedReasoningLevels,
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
  const native = nativeReasoningLevels(result);
  return native.length > 0 ? native : null;
}

function seedFallback(): UpsertModelInput[] {
  return CHATGPT_SEED_MODELS.map((m) => ({
    model_id: m.model_id,
    name: m.name,
    context_window: m.context_window,
    source: 'live' as const,
    // Carry reasoning hints so the admin reasoning-effort dropdown renders
    // even when the live `/models` discovery is unreachable. Live discovery
    // overwrites these with the upstream-advertised values when it succeeds.
    can_reason: Boolean(m.default_reasoning_level || m.supported_reasoning_levels?.length),
    default_reasoning_level: nativeReasoningLevel(m.default_reasoning_level),
    supported_reasoning_levels: normalizeReasoningLevels(m.supported_reasoning_levels ?? undefined),
    apply_patch_tool_type: m.apply_patch_tool_type ?? null,
  }));
}
