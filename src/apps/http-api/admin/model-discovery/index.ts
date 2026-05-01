/**
 * Live model discovery dispatcher.
 *
 * Per-kind fetchers are split into sibling files; this module picks the right
 * one based on `cfg.kind` and returns a {@link DiscoveryResult} the caller
 * stores via `ProviderStore.replaceModelsFromSource(..., 'live', ...)`.
 *
 * Most providers don't expose an ETag, so they return `etag: null` and
 * `notModified: false`. The ChatGPT/Codex backend is the exception: its
 * `/models` endpoint returns an `ETag` that we replay via `If-None-Match`
 * to skip unchanged refreshes.
 *
 * Intentionally not unified with src/agent/providers/model-discovery.ts —
 * that class is scoped to the agent indexer and carries DiscoveredModel
 * typing that doesn't quite match UpsertModelInput. A later slice can merge
 * them.
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '../../../../store/provider-store.js';
import { discoverChatgpt } from './chatgpt.js';
import { discoverCopilot } from './copilot.js';
import { discoverOpenai } from './openai.js';
import { discoverAnthropic } from './anthropic.js';
import { discoverClaudeCode } from './claude-code.js';
import { discoverGemini } from './gemini.js';
import { discoverBedrock } from './bedrock.js';
import { discoverGoogleOAuth } from './google-oauth.js';

export interface DiscoveryResult {
  models: UpsertModelInput[];
  /** Catalog ETag returned by the provider, or null when unavailable. */
  etag: string | null;
  /**
   * True when the upstream returned 304 Not Modified. In that case `models`
   * is empty (not a wipe) — the caller should leave the existing rows alone.
   */
  notModified: boolean;
}

export async function discoverModels(
  store: ProviderStore,
  cfg: ProviderConfig,
  previousEtag?: string | null,
): Promise<DiscoveryResult> {
  switch (cfg.kind) {
    case 'chatgpt':
      return discoverChatgpt(cfg, previousEtag ?? null);
    case 'copilot':
      return wrap(await discoverCopilot(store, cfg));
    case 'openai':
      return wrap(await discoverOpenai(cfg));
    case 'anthropic':
      return wrap(await discoverAnthropic(cfg));
    case 'claude-code':
      return wrap(await discoverClaudeCode(store, cfg));
    case 'gemini':
      return wrap(await discoverGemini(cfg));
    case 'bedrock':
      return wrap(await discoverBedrock(store, cfg));
    case 'google-oauth':
      return wrap(await discoverGoogleOAuth(store, cfg));
    default:
      throw new Error(`Live discovery not implemented for kind=${cfg.kind}`);
  }
}

function wrap(models: UpsertModelInput[]): DiscoveryResult {
  return { models, etag: null, notModified: false };
}
