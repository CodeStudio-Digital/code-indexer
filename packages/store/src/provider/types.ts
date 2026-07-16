/**
 * Logical kind of a provider — drives which adapter is instantiated.
 *
 * Runtime-validated string; the provider registry at
 * `packages/services/src/providers/registry.ts` is the source of truth
 * for valid shapes. Known built-ins for IDE autocompletion:
 * 'anthropic' | 'claude-code' | 'openai' | 'openrouter' | 'gemini' | 'bedrock' | 'copilot' | 'chatgpt' | 'deepseek' | 'zai' | 'kimi-code'
 */
export type ProviderKind = string;

/** How credentials are supplied. */
export type AuthMode = 'api_key' | 'oauth' | 'aws_sigv4';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  api_key: string | null;
  auth_mode: AuthMode;
  enabled: boolean;
  use_for_agent: boolean;
  use_for_coder: boolean;
  /**
   * When true this provider is eligible as the backend for "general AI"
   * utilities (commit message suggestions, etc). The actual selection
   * lives in `app_settings['general_default_model']`.
   */
  use_for_general: boolean;
  is_default: boolean;
  /** Parsed JSON blob. Free-form per-kind (aws_region, zai_has_coding_mode, ...). */
  extra: Record<string, unknown>;
  /** ID of the fallback provider to switch to on persistent errors. */
  fallback_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderModel {
  provider_id: string;
  model_id: string;
  /** '' = provider doesn't distinguish modes; 'normal'|'coding' used by ZAI. */
  mode: string;
  name: string;
  context_window: number | null;
  /**
   * True when the admin manually set `context_window` (migration 175). Live
   * discovery refreshes leave a flagged row's window alone — without this,
   * every refresh (incl. the one ~10s after each startup) re-derives the
   * window from discovery and silently reverts the admin's value (e.g. a
   * `glm-5.2` bumped to 1M reverting to the registry's 200K).
   */
  context_window_overridden: boolean;
  default_max_tokens: number | null;
  can_reason: boolean;
  supports_attachments: boolean;
  enabled: boolean;
  /** 'manual' | 'live' (from provider API) | 'hardcoded' (legacy fallback). */
  source: string;
  updated_at: string;
  // Rich metadata (migration 052) — populated by providers that expose it.
  display_name: string | null;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: string[] | null;
  apply_patch_tool_type: string | null;
  available_in_plans: string[] | null;
  minimal_client_version: string | null;
  visibility: string | null;
  supported_in_api: boolean | null;
  input_modalities: string[] | null;
  /**
   * Admin-set cap on how many tools the coder ships to this model per turn
   * (migration 135). NULL = use the static MODEL_REGISTRY / prefix
   * fallbacks. Live discovery never supplies it; preserved across
   * `replaceFromSource` refreshes like `default_reasoning_level`.
   */
  max_tools: number | null;
}

export interface OAuthTokenRow {
  provider_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  extra: Record<string, unknown>;
  updated_at: string;
}

export interface UpsertProviderInput {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url?: string | null;
  api_key?: string | null;
  auth_mode?: AuthMode;
  enabled?: boolean;
  use_for_agent?: boolean;
  use_for_coder?: boolean;
  use_for_general?: boolean;
  is_default?: boolean;
  extra?: Record<string, unknown>;
}

export interface UpsertModelInput {
  model_id: string;
  mode?: string;
  name: string;
  context_window?: number | null;
  /**
   * Carries the admin-override marker through `replaceFromSource` rebuilds
   * (migration 175). Live discovery omits it (= not an override). Existing
   * flagged rows keep their window regardless of what this input carries.
   */
  context_window_overridden?: boolean;
  default_max_tokens?: number | null;
  can_reason?: boolean;
  supports_attachments?: boolean;
  /**
   * Force the `enabled` flag. When undefined, `replaceModelsFromSource`
   * preserves the existing DB value for known rows and uses
   * `default_enabled` (or `true`) for newly seen rows.
   */
  enabled?: boolean;
  /**
   * Default `enabled` value for rows that don't yet exist. Only read when
   * `enabled` is undefined and there's no prior row. Use this from live
   * discovery to disable hidden / non-API models on first sight without
   * overriding subsequent admin toggles.
   */
  default_enabled?: boolean;
  source?: string;
  // Rich metadata (migration 052). Pass null to clear, omit to leave NULL.
  display_name?: string | null;
  description?: string | null;
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: string[] | null;
  apply_patch_tool_type?: string | null;
  available_in_plans?: string[] | null;
  minimal_client_version?: string | null;
  visibility?: string | null;
  supported_in_api?: boolean | null;
  input_modalities?: string[] | null;
  /** Seed for newly seen rows only — existing rows keep the admin's value. */
  max_tools?: number | null;
}

/**
 * One pricing row in `model_prices` (migration 111). Unit is USD per 1M
 * tokens. `provider` is '' for cross-provider price lists (OpenRouter /
 * LiteLLM); a provider-specific string scopes the row to one provider.
 * `source` is the origin: 'openrouter' | 'litellm' | 'manual' | 'hardcoded'.
 */
export interface ModelPriceRow {
  provider: string;
  model_id: string;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  currency: string;
  source: string;
  source_model_ref: string | null;
  fetched_at: string | null;
  updated_at: string;
}

export interface UpsertModelPriceInput {
  /** '' (or omitted) = cross-provider. */
  provider?: string | null;
  model_id: string;
  input_per_mtok?: number | null;
  output_per_mtok?: number | null;
  cache_read_per_mtok?: number | null;
  cache_write_per_mtok?: number | null;
  currency?: string;
  /** Raw upstream id before normalization (audit/debug only). */
  source_model_ref?: string | null;
  /** Upstream freshness (ISO). Null for the offline seed. */
  fetched_at?: string | null;
}
