/**
 * The provider authoring surface — the "ponta na SDK".
 *
 * A provider is declared once with `defineProvider({...})` and automatically
 * surfaces in the CLI wizard, admin picker, model discovery, cost lookup, and
 * both factories. This contract is the stable boundary third-party / plugin
 * providers integrate against.
 */
import type { ChatProvider } from './adapter.js';
import type { LLMProvider } from './indexer.js';
import type { CredKind, ResolvedCreds, ProviderConfigLike } from './credentials.js';
import type { AuthDescriptor, ProviderAuthHandlers } from './auth.js';

/** Current major version of the provider contract (see README §versioning). */
export const PROVIDER_SDK_VERSION = 1 as const;

// ─── Metadata ────────────────────────────────────────────────────
export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
}

export interface ProviderCapabilities {
  zaiCodingMode?: boolean;
  supportsThinking?: boolean;
  supportsVision?: boolean;
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

/** Context handed to a provider's connectivity check. */
export interface ProviderTestContext {
  /** The stored provider instance being tested. */
  config: ProviderConfigLike;
  /** Credentials already resolved (OAuth tokens refreshed) by the registry. */
  creds: ResolvedCreds;
}

/**
 * Extra options for coder construction that don't belong on credentials.
 * Kept as an interface so new fields are additive without breaking definitions.
 */
export interface CreateCoderOpts {
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
   * Imperative OAuth handlers (start/poll/refresh/logout) — a plugin OAuth
   * provider implements only what its `auth.flavor` needs, using host-provided
   * primitives (pkce/loopback/device-code). Lets it connect + refresh without
   * any per-kind core code.
   */
  authHandlers?: ProviderAuthHandlers;
  /** Optional dynamic model listing via the provider's API. */
  fetchModels?(creds: ResolvedCreds): Promise<string[]>;
  /**
   * Optional connectivity check for the admin "Test" badge. Receives creds
   * already resolved (OAuth refreshed) by the registry; throws on failure
   * (the message surfaces in the UI). Shapes without one are treated as a
   * no-op pass.
   */
  testConnection?(ctx: ProviderTestContext): Promise<void>;
  /** Build an indexer (single-shot) client for this shape. */
  createIndexer?(creds: ResolvedCreds, model?: string): LLMProvider;
  /** Build an async indexer (OAuth shapes that need token refresh). */
  createIndexerAsync?(creds: ResolvedCreds, model?: string): Promise<LLMProvider>;
  /** Build a coder (streaming) client for this shape. */
  createCoder?(creds: ResolvedCreds, model?: string, opts?: CreateCoderOpts): ChatProvider;
}

export function defineProvider(def: ProviderDefinition): ProviderDefinition {
  return def;
}
