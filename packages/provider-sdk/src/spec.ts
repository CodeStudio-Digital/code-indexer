/**
 * `ProviderSpec` — the DECLARATIVE provider authoring surface.
 *
 * Pure data, JSON-serializable, ZERO functions. Authored identically by
 * built-ins and by plugins (a plugin keeps it next to its adapter, importing only
 * the provider SDK/runtime). The runtime turns a spec into a
 * runtime `ProviderDefinition` (adapter + live model discovery + connectivity
 * test) keyed by `wire`. This is the single mechanism — no per-provider adapter
 * code anywhere.
 *
 * `defaultModels` / `pricing` / `models` are SEED/fallback only; the source of
 * truth is live discovery (and the pricing-refresh) which overlay them,
 * preserving admin overrides.
 */
import type { CredKind } from './credentials.js';
import type { ProviderVisual, ProviderCapabilities, PricingEntry, ProviderConfigDescriptor } from './provider.js';
import type { AuthDescriptor } from './auth.js';

/** Current major version of the spec contract. */
export const PROVIDER_SPEC_VERSION = 1 as const;

/** The wire protocol — selects the host adapter + the discovery format. */
export type WireKind = 'openai-compat' | 'anthropic' | 'gemini' | 'bedrock' | 'codex' | 'kimi';

/** OpenAI-compatible vendor flag (enables vendor-specific request tweaks). */
export type OpenAICompatVendor = 'openai' | 'openrouter' | 'zai' | 'deepseek' | 'copilot' | 'fugu';

/** Reads a value from `cfg.extra[key]` or `process.env[key]`. */
export interface ValueSource {
  from: 'extra' | 'env';
  key: string;
}

/** A template variable filled from the first non-empty of several sources. */
export interface TemplateVar {
  /** Tried in order; first non-empty wins. */
  sources: ValueSource[];
  /** Throw `errorMessage` when none resolve. */
  required?: boolean;
  errorMessage?: string;
}

/**
 * Per-wire declarative knobs. Each captures a "B-class" rule (account-id
 * templating, ::mode routing, attribution headers, thinking mode) or a
 * "C-class" flag (claudeCode/geminiOAuth/responsesApi) as DATA the runtime
 * interprets — so no per-provider code is needed.
 */
export interface WireOpts {
  // openai-compat
  vendor?: OpenAICompatVendor;
  /** Base URL with `{var}` placeholders filled from `baseUrlVars` (cloudflare). */
  baseUrlTemplate?: string;
  baseUrlVars?: Record<string, TemplateVar>;
  /** `::coding`/`::general` model-suffix → per-mode baseURL (zai). */
  modelModes?: {
    map: Record<string, { baseURL: string }>;
    /** env var that overrides the resolved baseURL entirely (e.g. ZAI_BASE_URL). */
    envOverride?: string;
    /**
     * `extra` key holding a provider-level DEFAULT mode (e.g. 'zai_mode'). Used
     * when the model id carries no `::mode` suffix — the provider's "plan mode"
     * select. The per-model suffix still overrides it per request.
     */
    defaultModeKey?: string;
  };
  /** Attribution / extra headers built from cfg.extra/env (openrouter). Each
   *  header takes the first non-empty of its sources (extra and/or env). */
  headerSources?: Array<{ header: string; sources: ValueSource[] }>;
  /** Per-request thinking mode read from creds.extra (kimi). */
  thinkingMode?: { from: 'extra'; key: string; default: 'auto' | 'enabled' | 'disabled' };

  // anthropic
  /** Static extended-thinking config (anthropic api-key). */
  defaultThinking?: { type: 'enabled'; budget_tokens: number };
  /** Turn on Claude-Code model resolution + system prefix blocks + bearer dispatch. */
  claudeCode?: boolean;

  // gemini
  /** Route via OAuth accessToken/refreshToken/projectId instead of api-key. */
  geminiOAuth?: boolean;

  // codex
  /** Use the OpenAI Responses API (stateful) rather than chat/completions. */
  responsesApi?: boolean;

  // indexer
  /** Cheap default model for summary-only indexing. */
  summaryModelDefault?: string;
  /** Primary indexer model default when the caller passes none (may differ from
   *  the coder default — e.g. cloudflare uses a smaller model for indexing). */
  indexerDefaultModel?: string;
}

/** A JSON-serializable value (request body injection is static JSON). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Declarative HTTP-request customization — the "freedom in the request" surface.
 *
 * PURE DATA (no functions), so it is third-party-safe: a plugin can adapt an
 * OpenAI-/Anthropic-compatible vendor that deviates from the wire's native
 * request (non-standard auth header, extra headers, query params, model-id
 * rewriting, static body tweaks, a non-standard reasoning field) WITHOUT any
 * host code. Absent → the wire takes its exact native code path (byte-identical).
 *
 * String values support a closed template grammar resolved against a fixed
 * context — `{apiKey}`, `{baseURL}`, `{model}`, `{extra.KEY}`, `{env.KEY}` —
 * never expressions or code (same safety profile as `baseUrlTemplate`). Dynamic
 * per-request logic (effort→budget, vendor model-family gating) is NOT
 * expressible here by design; that stays first-party in the wire's `vendor`
 * switch, and a genuinely exotic provider gets a new first-party wire.
 */
export interface RequestDescriptor {
  /**
   * Override the auth header name + scheme. Absent → the wire's native scheme
   * (openai-compat: `Authorization: Bearer`). e.g. `{header:'x-api-key',
   * valueTemplate:'{apiKey}'}` or `{header:'Authorization', valueTemplate:
   * '{apiKey}'}` (no Bearer). Only honored on the api-key path (see schema).
   */
  auth?: { header: string; valueTemplate: string };
  /** Extra request headers (literal or templated). Merged after the base headers. */
  headers?: Array<{ header: string; value: string }>;
  /** Query params appended to the chat request URL (e.g. Azure `api-version`). */
  query?: Record<string, string>;
  /** Rewrite the model id before it hits the wire (after any `::mode` split). */
  model?: {
    /** Strip these suffixes if present (e.g. '-latest'). */
    stripSuffix?: string[];
    /** Exact id → wire id remap (alias → deployment). Applied after stripSuffix. */
    map?: Record<string, string>;
    /** Template producing the final id, e.g. 'deployments/{model}'. Applied last. */
    template?: string;
  };
  /** Static request-body injection/removal (vendor knobs as data). */
  body?: {
    /** Shallow-merged into the request body (e.g. `{max_tokens:32000}`). */
    inject?: Record<string, JsonValue>;
    /** Top-level keys removed from the body before send (e.g. ['temperature']). */
    remove?: string[];
  };
  /** Map a non-standard streaming-response field to the engine's canonical one. */
  response?: {
    /** Delta key carrying chain-of-thought text (default: 'reasoning_content'). */
    reasoningDeltaKey?: string;
  };
}

/** How the host fetches the LIVE model list for this provider. */
export type DiscoveryFormat =
  | 'openai-models' // {baseURL}/models — Bearer
  | 'anthropic-models' // /v1/models — x-api-key + version
  | 'gemini-models' // generativelanguage …?key=
  | 'openrouter-models' // /models?output_modalities=text — rich metadata
  | 'cloudflare-models' // /accounts/{account_id}/ai/models/search
  | 'chatgpt-models' // /models?client_version — ETag + seed fallback
  | 'sdk:bedrock'
  | 'sdk:copilot'
  | 'sdk:claude-code'
  | 'sdk:kimi-code'
  | 'sdk:google-oauth' // generativelanguage via OAuth Bearer (refresh-on-demand)
  | 'static'; // defaultModels only

/** Connectivity-check format for the admin "Test" badge. */
export type TestFormat =
  | 'openai-models' // ping {base}/models, Bearer (+ extraHeaders) — openai/openrouter/copilot
  | 'anthropic-models' // ping {base}/v1/models, x-api-key
  | 'gemini-key' // ping generativelanguage …?key=
  | 'gemini-oauth' // ping generativelanguage, Bearer (google-oauth)
  | 'codex-health' // ping {base}/health (chatgpt)
  | 'sdk:kimi-code'
  | 'sdk:claude-code'
  | 'unsupported'; // throws `message` (bedrock)

export interface TestDescriptor {
  from: TestFormat;
  /** Fallback base URL when neither creds.baseURL nor defaultBaseURL apply. */
  fallbackBaseURL?: string;
  /** Error thrown for `unsupported`. */
  message?: string;
}

export interface DiscoveryDescriptor {
  from: DiscoveryFormat;
  /** Override the models endpoint (else derived from baseURL per format). */
  modelsUrl?: string;
  queryParams?: Record<string, string>;
  /** openai-compat: keep only ids with one of these prefixes (moonshot). */
  filterPrefixes?: string[];
  /** openai-compat: require boolean capabilities advertised by each model row. */
  requiredCapabilities?: string[];
  /** zai: also emit `::coding`/`::general` variants when the flag is set. */
  supportsModes?: string[];
  /** cloudflare: where the account id comes from. */
  accountIdFrom?: TemplateVar;
}

/** Seed metadata for a model (fallback for the C-cases; live discovery overlays). */
export interface ProviderModelMeta {
  contextWindow?: number;
  maxTokens?: number;
  supportedReasoningLevels?: string[] | null;
  defaultReasoningLevel?: string | null;
  applyPatchToolType?: string | null;
}

export interface ProviderSpec {
  specVersion?: number;
  // ── identity ──
  kind: string;
  displayName: string;
  visual?: ProviderVisual;
  credKind: CredKind;
  envVars: string[];
  defaultBaseURL?: string;
  /** Offline fallback model list (live discovery is the source of truth). */
  defaultModels: string[];
  defaultModel?: string;
  /** Seed pricing (the live pricing-refresh overlays). */
  pricing: Record<string, PricingEntry>;
  /**
   * Tie-breaker for cross-provider duplicate model ids in `pricing.ts`. When two
   * registered providers price the same model id, the LOWER priority wins
   * (default 0, stable insertion order otherwise). Lets a provider pin its
   * pricing precedence as DATA — surviving the plugin round-trip — independent of
   * registry/plugin load order. e.g. kimi-code ($0 plan) < moonshot (metered)
   * for the shared `kimi-k2-*-turbo` ids.
   */
  pricingPriority?: number;
  capabilities?: ProviderCapabilities;
  // ── wire + per-wire knobs ──
  wire: WireKind;
  wireOpts?: WireOpts;
  /** Declarative HTTP-request customization (default = wire native). */
  request?: RequestDescriptor;
  // ── live model discovery ──
  discovery?: DiscoveryDescriptor;
  /** Per-model seed metadata; live discovery overlays, preserving admin overrides. */
  models?: Record<string, ProviderModelMeta>;
  /** Connectivity check for the admin "Test" badge. Omit → no-op pass. */
  test?: TestDescriptor;
  // ── connect flow ──
  auth?: AuthDescriptor;
  /** Declarative settings form (extra fields beyond api_key/base_url). */
  config?: ProviderConfigDescriptor;
}

/** Authoring helper (identity) — gives full typing + a stable seam. */
export function defineProviderSpec(spec: ProviderSpec): ProviderSpec {
  return spec;
}
