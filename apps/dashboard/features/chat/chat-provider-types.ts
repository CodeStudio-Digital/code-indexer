

export interface EnrichedProviderModel {
  id: string;
  name: string;
  mode: string | null;
  context_window?: number | null;
  default_max_tokens?: number | null;
  /** Discrete reasoning-effort levels this model accepts (e.g.
   *  `['minimal','low','medium','high','xhigh']`). Non-empty → the composer
   *  shows the effort selector. Null/empty → hidden. */
  supported_reasoning_levels?: string[] | null;
  /** Model's default effort when no override is set. Shown as the "auto" hint. */
  default_reasoning_level?: string | null;
  /** Persisted provider-model capability when exposed by the API. Older
   * servers omit it; the dashboard also derives a safe value from native
   * reasoning metadata. */
  can_reason?: boolean;
}

interface ProviderCapabilities {
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

export interface EnrichedProvider {
  id: string;
  name: string;
  kind: string;
  is_default?: boolean;
  has_key?: boolean;
  models: EnrichedProviderModel[];
  capabilities?: ProviderCapabilities;
}

export interface ProviderOption {
  id: string;
  label: string;
  /** The provider's `kind` (e.g. `'chatgpt'`, `'openai'`, `'gemini'`).
   *  Distinct from `id` for providers whose DB id doesn't match the kind
   *  (e.g. ChatGPT Codex has id `openai-chatgpt` but kind `chatgpt`). */
  kind?: string;
  models: EnrichedProviderModel[];
  capabilities?: ProviderCapabilities;
}
