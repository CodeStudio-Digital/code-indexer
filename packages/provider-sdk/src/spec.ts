/**
 * `ProviderSpec` — the DECLARATIVE provider authoring surface.
 *
 * Pure data, JSON-serializable, ZERO functions. Authored identically by
 * built-ins and by plugins (a plugin puts it in its `.app.json`, importing only
 * `@mcp/plugin-sdk`). The host's `@mcp/provider-engine` turns a spec into a
 * runtime `ProviderDefinition` (adapter + live model discovery + connectivity
 * test) keyed by `wire`. This is the single mechanism — no per-provider adapter
 * code anywhere.
 *
 * `defaultModels` / `pricing` / `models` are SEED/fallback only; the source of
 * truth is live discovery (and the pricing-refresh) which overlay them,
 * preserving admin overrides.
 */
import type { CredKind } from './credentials.js';
import type { ProviderVisual, ProviderCapabilities, PricingEntry } from './provider.js';
import type { AuthDescriptor } from './auth.js';

/** Current major version of the spec contract. */
export const PROVIDER_SPEC_VERSION = 1 as const;

/** The wire protocol — selects the host adapter + the discovery format. */
export type WireKind = 'openai-compat' | 'anthropic' | 'gemini' | 'bedrock' | 'codex' | 'kimi';

/** OpenAI-compatible vendor flag (enables vendor-specific request tweaks). */
export type OpenAICompatVendor = 'openai' | 'openrouter' | 'zai' | 'deepseek' | 'copilot';

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
 * "C-class" flag (claudeCode/geminiOAuth/responsesApi) as DATA the engine
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
  capabilities?: ProviderCapabilities;
  // ── wire + per-wire knobs ──
  wire: WireKind;
  wireOpts?: WireOpts;
  // ── live model discovery ──
  discovery?: DiscoveryDescriptor;
  /** Per-model seed metadata; live discovery overlays, preserving admin overrides. */
  models?: Record<string, ProviderModelMeta>;
  /** Connectivity check for the admin "Test" badge. Omit → no-op pass. */
  test?: TestDescriptor;
  // ── connect flow ──
  auth?: AuthDescriptor;
}

/** Authoring helper (identity) — gives full typing + a stable seam. */
export function defineProviderSpec(spec: ProviderSpec): ProviderSpec {
  return spec;
}
