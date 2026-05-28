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

/**
 * Operator-pinned defaults for the simulated deepThink mode. When the chat
 * composer toggles `deepthink+` without overriding fields, the runner reads
 * these to pick the auxiliary model + tuning knobs.
 */
export interface DeepThinkDefaults {
  provider: string | null;
  model: string | null;
  /** Hard timeout for the auxiliary call (ms). Default 8000 when null. */
  timeoutMs: number | null;
  /** How many <thinking data-source="aux"> blocks to keep in history. Default 3. */
  historyWindow: number | null;
  /** Skip auxiliary when last user text is shorter than this (~chars/4). Default 0 (no filter). */
  minInputTokens: number | null;
  /** Run pre-think on tool_result turns too. Default false. */
  preThinkOnToolResults: boolean;
}

export type EmbeddingKind = 'cloudflare' | 'bedrock' | 'null';

export interface EmbeddingConfigRow {
  id: string;
  kind: EmbeddingKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

/**
 * Vector store backends. Decoupled from EmbeddingKind because a user can
 * generate embeddings with Bedrock Titan and store them in Qdrant, etc.
 */
export type VectorStoreKind = 'cloudflare' | 'qdrant' | 'bedrock-opensearch' | 'pinecone' | 'null';

export interface VectorStoreConfigRow {
  id: string;
  kind: VectorStoreKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
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
}
