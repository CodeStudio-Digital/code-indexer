import type {
  AuthMode,
  OAuthTokenRow,
  ProviderConfig,
  ProviderKind,
  ProviderModel,
} from './types.js';
import { getOpenAIApiModelMetadata, isPublicOpenAIApi } from '@mcp/shared/providers/openai-api-models.js';
import { getZaiModelReasoning } from '@mcp/shared/providers/zai-models.js';

function normalizeNativeReasoningLevel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const level = value.trim();
  return level && level.toLowerCase() !== 'ultra' ? level : null;
}

export interface ProviderConfigRaw {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  api_key: string | null;
  auth_mode: string;
  enabled: number;
  use_for_agent: number;
  use_for_coder: number;
  use_for_general: number;
  is_default: number;
  extra: string | null;
  fallback_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderModelRaw {
  provider_kind?: string;
  provider_base_url?: string | null;
  provider_id: string;
  model_id: string;
  mode: string;
  name: string;
  context_window: number | null;
  context_window_overridden: number | null;
  default_max_tokens: number | null;
  can_reason: number;
  supports_attachments: number;
  enabled: number;
  source: string;
  updated_at: string;
  display_name: string | null;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: string | null;
  apply_patch_tool_type: string | null;
  available_in_plans: string | null;
  minimal_client_version: string | null;
  visibility: string | null;
  supported_in_api: number | null;
  input_modalities: string | null;
  max_tools: number | null;
}

export interface OAuthTokenRaw {
  provider_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  extra: string | null;
  updated_at: string;
}

export function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; }
  catch { return fallback; }
}

export function hydrateProvider(r: ProviderConfigRaw): ProviderConfig {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ProviderKind,
    base_url: r.base_url,
    api_key: r.api_key,
    auth_mode: r.auth_mode as AuthMode,
    enabled: !!r.enabled,
    use_for_agent: !!r.use_for_agent,
    use_for_coder: !!r.use_for_coder,
    use_for_general: !!r.use_for_general,
    is_default: !!r.is_default,
    extra: parseJson<Record<string, unknown>>(r.extra, {}),
    fallback_provider_id: r.fallback_provider_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeStoredLevels(levels: unknown[] | null): string[] | null {
  if (!levels) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const lv of levels) {
    let raw: unknown = lv;
    if (typeof lv === 'string') {
      raw = lv;
    } else if (lv && typeof lv === 'object' && 'effort' in lv && typeof (lv as Record<string, unknown>).effort === 'string') {
      raw = (lv as Record<string, unknown>).effort;
    }
    const level = normalizeNativeReasoningLevel(raw);
    if (!level || seen.has(level.toLowerCase())) continue;
    seen.add(level.toLowerCase());
    result.push(level);
  }
  return result.length > 0 ? result : null;
}

export function hydrateModel(r: ProviderModelRaw): ProviderModel {
  const published = isPublicOpenAIApi(r.provider_kind, r.provider_base_url)
    ? getOpenAIApiModelMetadata(r.model_id) : undefined;
  const zaiReasoning = r.provider_kind === 'zai' ? getZaiModelReasoning(r.model_id) : undefined;
  const storedDefault = normalizeNativeReasoningLevel(r.default_reasoning_level);
  const defaultReasoningLevel = zaiReasoning
    ? zaiReasoning.supportedReasoningLevels.find(level => level === storedDefault?.toLowerCase()) ?? null
    : storedDefault;
  const supportedReasoningLevels = zaiReasoning?.supportedReasoningLevels ?? normalizeStoredLevels(
    parseJson<unknown[] | null>(r.supported_reasoning_levels, null),
  ) ?? published?.supportedReasoningLevels ?? null;
  // Repair pre-fix API catalogs at the read boundary: no network, polling or
  // destructive migration. Preserve manual limits and real upstream metadata.
  const legacyWindow = r.context_window == null || r.context_window === 272_000 || r.context_window === 372_000;
  const contextWindow = published && !r.context_window_overridden
    && !(r.source === 'manual' && r.context_window != null) && legacyWindow
    ? published.contextWindow : r.context_window;
  return {
    provider_id: r.provider_id,
    model_id: r.model_id,
    mode: r.mode,
    name: r.name,
    context_window: contextWindow,
    context_window_overridden: !!r.context_window_overridden,
    default_max_tokens: r.default_max_tokens,
    // Infer capability from native metadata as a read-boundary repair for
    // older catalogs that persisted levels while leaving can_reason at 0.
    can_reason: !!r.can_reason || defaultReasoningLevel !== null || supportedReasoningLevels !== null || published?.canReason === true,
    supports_attachments: !!r.supports_attachments || published?.supportsAttachments === true,
    enabled: !!r.enabled,
    source: r.source,
    updated_at: r.updated_at,
    display_name: r.display_name,
    description: r.description,
    default_reasoning_level: defaultReasoningLevel,
    supported_reasoning_levels: supportedReasoningLevels ? [...supportedReasoningLevels] : null,
    apply_patch_tool_type: r.apply_patch_tool_type,
    available_in_plans: parseJson<string[] | null>(r.available_in_plans, null),
    minimal_client_version: r.minimal_client_version,
    visibility: r.visibility,
    supported_in_api: r.supported_in_api === null ? null : !!r.supported_in_api,
    input_modalities: parseJson<string[] | null>(r.input_modalities, null) ?? (published ? [...published.inputModalities] : null),
    max_tools: r.max_tools ?? null,
  };
}

export function hydrateOAuth(r: OAuthTokenRaw): OAuthTokenRow {
  return {
    provider_id: r.provider_id,
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at,
    scope: r.scope,
    extra: parseJson<Record<string, unknown>>(r.extra, {}),
    updated_at: r.updated_at,
  };
}
