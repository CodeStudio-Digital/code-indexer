/**
 * Public types for the provider registry.
 *
 * The LLMProvider (indexer) and ChatProvider (coder) interfaces are
 * re-exported verbatim from the existing base/adapter modules so this
 * refactor is behavior-preserving. New types live below.
 */

export type { LLMProvider } from '../indexer/providers/base.js';
export type { ChatProvider, ChatRequest, ToolSpec, CoderProviderName } from '../coder/providers/adapter.js';

import type { LLMProvider } from '../indexer/providers/base.js';
import type { ChatProvider } from '../coder/providers/adapter.js';

// ─── Registry / Definition ───────────────────────────────────────
export type CredKind = 'api-key' | 'oauth' | 'aws';

export interface ResolvedCreds {
  apiKey?: string;
  baseURL?: string;
  extraHeaders?: Record<string, string>;
  aws?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    region?: string;
  };
  /** OAuth-specific scratch (accountId for ChatGPT, editor opts for Copilot). */
  extra?: Record<string, unknown>;
}

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
 * Extra options for coder construction that don't belong on credentials.
 * Currently only carries `cloudCodeSessionId` (used by Google OAuth / Gemini
 * CloudCode to keep context-cache affinity across requests). Kept as an
 * interface so new fields are additive without breaking all definitions.
 */
export interface CreateCoderOpts {
  /**
   * Gemini CloudCode session id — when set, the Google OAuth backend
   * reuses server-side context cache across requests, cutting token cost.
   * Unused by every other shape.
   */
  cloudCodeSessionId?: string;
}

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
  /** Per-model pricing. Used by pricing.ts::lookupPricing. */
  pricing: Record<string, PricingEntry>;
  capabilities?: ProviderCapabilities;
  /** Optional dynamic model listing via the provider's API. */
  fetchModels?(creds: ResolvedCreds): Promise<string[]>;
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
