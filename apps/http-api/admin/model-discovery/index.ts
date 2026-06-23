/**
 * Live model discovery dispatcher.
 *
 * Spec-driven: resolves the provider's `ProviderSpec` by kind and delegates to
 * `@mcp/provider-engine`'s `discoverModels`, which implements every format
 * (HTTP `/models`, the ChatGPT/Codex ETag path, and the OAuth/sdk fetchers). The
 * per-kind `discoverX` sibling modules are now the equivalence-test reference for
 * the engine builders and are removed in the cleanup phase.
 *
 * `ENGINE_DISCOVERY_KINDS` is the allow-list of kinds that had a live-discovery
 * case before the cutover. deepseek/zai are intentionally EXCLUDED — they never
 * had an admin case (live discovery happens only in the indexer), so they keep
 * throwing here; routing their `openai-models` spec through the engine would
 * newly enable live discovery for them (a behavior change).
 *
 * The {@link DiscoveryResult} shape and the `(store, cfg, previousEtag?)`
 * signature are unchanged, so all callers (refresh route, scheduler, the OAuth
 * post-auth seeds) are untouched.
 */
import type { ProviderStore, ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getSpecByKind, discoverModels as engineDiscoverModels } from '@mcp/provider-engine';

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

const ENGINE_DISCOVERY_KINDS = new Set<string>([
  'chatgpt',
  'copilot',
  'openai',
  'anthropic',
  'claude-code',
  'gemini',
  'bedrock',
  'google-oauth',
  'kimi-code',
  'cloudflare',
  'moonshot',
  'openrouter',
]);

export async function discoverModels(
  store: ProviderStore,
  cfg: ProviderConfig,
  previousEtag?: string | null,
): Promise<DiscoveryResult> {
  if (ENGINE_DISCOVERY_KINDS.has(cfg.kind)) {
    const spec = getSpecByKind(cfg.kind);
    if (spec) return engineDiscoverModels(spec, cfg, store, previousEtag ?? null);
  }
  throw new Error(`Live discovery not implemented for kind=${cfg.kind}`);
}
