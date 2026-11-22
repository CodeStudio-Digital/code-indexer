/**
 * The provider authoring surface — the "ponta na SDK".
 *
 * A provider is declared once with `defineProvider({...})` and automatically
 * surfaces in the CLI wizard, admin picker, model discovery, cost lookup, and
 * both factories. This contract is the stable boundary third-party / plugin
 * providers integrate against.
 */
import type { ChatProvider } from './adapter.js';
import type { CredKind, ResolvedCreds, ProviderConfigLike } from './credentials.js';
import type { AuthDescriptor, ProviderAuthHandlers, ProviderCredentials } from './auth.js';

/** Current major version of the metadata/provider-definition contract. */
export const PROVIDER_SDK_VERSION = 1 as const;
/** Current major version of the executable provider-adapter plugin contract. */
export const PROVIDER_ADAPTER_SDK_VERSION = 2 as const;

// ─── Metadata ────────────────────────────────────────────────────
export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
}

export interface ProviderCapabilities {
  zaiCodingMode?: boolean;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  /** How the transport consumes attached files before model inference. */
  fileInput?: 'native' | 'pdf-only' | 'text' | 'model-dependent';
  /** Provider exposes image-generation models (rows with mode 'image'). */
  supportsImageGen?: boolean;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
}

/**
 * Renderer-safe visual identity for a provider. The icon is a *string* (a
 * lucide icon name, e.g. `'Sparkles'`), never a component, so this can travel
 * over HTTP to the dashboard (which is outside the Node tsc graph) and be
 * resolved name→component there with a fallback.
 */
export interface ProviderVisual {
  /** lucide icon name, resolved in the renderer. */
  icon: string;
  /** Tailwind foreground class, e.g. `'text-orange-500'`. */
  fg: string;
  /** Tailwind background class, e.g. `'bg-orange-500/15'`. */
  bg: string;
}

// ─── Declarative config form ─────────────────────────────────────
/**
 * One field in a provider's declarative settings form. The admin UI renders
 * these (no per-kind code) so a plugin provider gets a tailored config screen.
 * `api_key` + `base_url` are rendered by the host form itself (every api-key
 * provider has them) — `fields` declares only the EXTRAS a provider needs.
 */
export type ConfigFieldType = 'text' | 'password' | 'select' | 'toggle';
/** Where a field's value is persisted on the provider_configs row. */
export type ConfigFieldStore = 'api_key' | 'base_url' | 'extra';

export interface ConfigFieldOption {
  value: string;
  label: string;
}

export interface ConfigField {
  /** Field id. For `storeIn: 'extra'` this is also the `extra.<key>` key. */
  key: string;
  type: ConfigFieldType;
  label: string;
  storeIn: ConfigFieldStore;
  /** Options for `type: 'select'`. */
  options?: ConfigFieldOption[];
  placeholder?: string;
  helpText?: string;
  /** When true, the field is optional (no required marker). */
  optional?: boolean;
  /** Render under an "Advanced" disclosure. */
  advanced?: boolean;
  /** Default value (string for text/select; 'true'/'false' for toggle). */
  default?: string;
}

export interface ProviderConfigDescriptor {
  fields: ConfigField[];
}

/** Context handed to a provider's connectivity check. */
export interface ProviderTestContext {
  /** The stored provider instance being tested. */
  config: ProviderConfigLike;
  /** Credentials already resolved (OAuth tokens refreshed) by the registry. */
  creds: ResolvedCreds;
}

/**
 * Provider-owned live model metadata. This is intentionally structural (rather
 * than importing @mcp/store) so the SDK stays a leaf package while remaining
 * assignable to the store's UpsertModelInput shape in the host.
 */
export interface ProviderDiscoveredModel {
  model_id: string;
  mode?: string;
  name: string;
  context_window?: number | null;
  context_window_overridden?: boolean;
  default_max_tokens?: number | null;
  can_reason?: boolean;
  supports_attachments?: boolean;
  enabled?: boolean;
  default_enabled?: boolean;
  source?: string;
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
  max_tools?: number | null;
}

export interface ProviderDiscoveryResult {
  models: ProviderDiscoveredModel[];
  /** Catalog ETag returned by the provider, or null when unavailable. */
  etag?: string | null;
  /** True when upstream returned 304 and existing stored rows should remain. */
  notModified?: boolean;
}

/** Persisted model metadata the host may pass to runtime builders. */
export interface ProviderRuntimeModelMetadata {
  model_id: string;
  /** Optional provider transport mode for catalogs that expose model variants. */
  mode?: string | null;
  /** Provider-advertised or admin-selected completion cap for this model. */
  default_max_tokens?: number | null;
  /** Whether the catalog says this model exposes any native reasoning mode. */
  can_reason?: boolean | null;
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: string[] | null;
  apply_patch_tool_type?: string | null;
}

export interface ProviderDiscoverModelsContext {
  /** The stored provider instance being refreshed. */
  config: ProviderConfigLike;
  /** Credentials already resolved through the provider-owned resolver. */
  creds: ResolvedCreds;
  /** Previous persisted catalog ETag, when the provider supports it. */
  previousEtag?: string | null;
  /** Network primitive. The host may wrap this later for proxy/telemetry policy. */
  fetch: typeof fetch;
  /** Best-effort diagnostic logger; callers must not log secrets. */
  log(message: string): void;
}

/** Context handed to an executable provider adapter when it owns credential resolution. */
export interface ProviderResolveCredentialsContext {
  /** The stored provider instance being resolved. */
  config: ProviderConfigLike;
  /** Per-provider OAuth/token store, backed by the host. */
  credentials: ProviderCredentials;
  /**
   * Resolve a host-owned exotic credential shape without importing host
   * services or persistence into the plugin bundle. Present only when the host
   * has a resolver for this provider kind (currently Claude Code).
   */
  resolveHostCredentials?: () => Promise<ResolvedCreds>;
  /** Network primitive. The host may wrap this later for proxy/telemetry policy. */
  fetch: typeof fetch;
  /** Best-effort diagnostic logger; callers must not log secrets. */
  log(message: string): void;
}

/**
 * Extra options for coder construction that don't belong on credentials.
 * Kept as an interface so new fields are additive without breaking definitions.
 */
export interface CreateCoderOpts {
  /** Utility conversations only consume generated text, including on hosted-tool-capable wires. */
  textOnly?: boolean;
  /**
   * Gemini CloudCode session id — when set, the Google OAuth backend reuses
   * server-side context cache across requests, cutting token cost.
   */
  cloudCodeSessionId?: string;
  /**
   * Database id of the provider_configs row this instance corresponds to.
   * Some shapes (currently ChatGPT) use it to look up persisted per-model
   * metadata (reasoning levels, apply_patch_tool_type, etc.).
   */
  providerId?: string;
  /**
   * Persisted per-model metadata for this provider instance. Passed by the
   * host so reusable provider runtimes do not need direct store access.
   */
  providerModels?: readonly ProviderRuntimeModelMetadata[];
}

// ─── Definition ──────────────────────────────────────────────────
export interface ProviderDefinition {
  /** SHAPE / API format. Registry key. */
  kind: string;
  /** Human-readable label for wizard/admin UI. */
  displayName: string;
  credKind: CredKind;
  /** Env vars that auto-seed an instance of this shape (built-ins). */
  envVars: string[];
  /** Fallback base URL when the instance row has no base_url set. */
  defaultBaseURL?: string;
  /** Fallback model list when live discovery is unavailable. */
  defaultModels: string[];
  /**
   * Preferred default model id when the caller passes only a provider (no
   * model). Falls back to `defaultModels[0]` when unset. Lets the registry
   * answer "what model should I use for this kind" without a hardcoded switch.
   */
  defaultModel?: string;
  /** Per-model pricing. Used by pricing.ts::lookupPricing. */
  pricing: Record<string, PricingEntry>;
  /**
   * Tie-breaker for cross-provider duplicate model ids: lower wins (default 0,
   * stable insertion order otherwise). `lookupPricing` sorts by this before its
   * first-match walk, so pricing precedence is independent of registry/plugin
   * load order.
   */
  pricingPriority?: number;
  capabilities?: ProviderCapabilities;
  /**
   * Renderer-safe visual identity. When set, the admin dashboard reads it
   * (via the `/providers/known` route) instead of a hardcoded icon map.
   */
  visual?: ProviderVisual;
  /**
   * Declarative connect-flow descriptor. The admin UI reads it to choose the
   * connect surface (api-key form vs device-code/loopback) and the host
   * pre-grants the OAuth capabilities the flow needs. Built-ins still work via
   * the legacy per-kind routes; a plugin OAuth provider relies on this.
   */
  auth?: AuthDescriptor;
  /**
   * Declarative settings form for a provider instance. The admin UI renders it
   * (api_key/base_url built-in + these EXTRA fields) so each provider — built-in
   * or plugin — gets a tailored config screen with no per-kind code.
   */
  config?: ProviderConfigDescriptor;
  /**
   * Imperative OAuth handlers (start/poll/refresh/logout) — a plugin OAuth
   * provider implements only what its `auth.flavor` needs, using host-provided
   * primitives (pkce/loopback/device-code). Lets it connect + refresh without
   * any per-kind core code.
   */
  authHandlers?: ProviderAuthHandlers;
  /**
   * Provider-owned credential resolution. When present, the core resolver calls
   * this before any legacy per-kind switch. This is the V2 seam that lets a
   * provider plugin own API keys, OAuth refresh, token exchange metadata and
   * AWS credential shaping while the host still owns encrypted persistence.
   */
  resolveCredentials?(ctx: ProviderResolveCredentialsContext): Promise<ResolvedCreds>;
  /** Optional dynamic model listing via the provider's API. */
  fetchModels?(creds: ResolvedCreds): Promise<string[]>;
  /**
   * Provider-owned rich model discovery. When present, the admin refresh path
   * calls this before the legacy provider-engine dispatcher, letting plugin
   * providers own catalog shape, ETags, visibility, reasoning metadata and
   * any OAuth/sdk quirks in their own bundle.
   */
  discoverModels?(ctx: ProviderDiscoverModelsContext): Promise<ProviderDiscoveryResult>;
  /**
   * Optional connectivity check for the admin "Test" badge. Receives creds
   * already resolved (OAuth refreshed) by the registry; throws on failure
   * (the message surfaces in the UI). Shapes without one are treated as a
   * no-op pass.
   */
  testConnection?(ctx: ProviderTestContext): Promise<void>;
  /** Build a coder (streaming) client for this shape. */
  createCoder?(creds: ResolvedCreds, model?: string, opts?: CreateCoderOpts): ChatProvider;
}

export function defineProvider(def: ProviderDefinition): ProviderDefinition {
  return def;
}
