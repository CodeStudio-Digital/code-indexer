/**
 * Live model discovery dispatcher.
 *
 * Spec-driven: resolves the provider's `ProviderSpec` by kind and delegates to
 * `@mcp/provider-engine`'s `discoverModels`, which implements every format
 * (HTTP `/models`, the ChatGPT/Codex ETag path, and the OAuth/sdk fetchers). The
 * per-kind `discoverX` sibling modules are now the equivalence-test reference for
 * the engine builders and are removed in the cleanup phase.
 *
 * A kind is routed iff its spec declares a real `discovery` (anything but
 * `static`). That auto-covers every built-in with live discovery (incl. zai /
 * deepseek, whose `openai-models` `/models` the admin Refresh now serves) and
 * fails closed for kinds with no/`static` discovery (no silent catalog wipe).
 *
 * The {@link DiscoveryResult} shape and the `(store, cfg, previousEtag?)`
 * signature are unchanged, so all callers (refresh route, scheduler, the OAuth
 * post-auth seeds) are untouched.
 */
import type { ProviderStore, ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getSpecByKind, discoverModels as engineDiscoverModels } from '@mcp/provider-engine';
import { listProviderPlugins } from '@mcp/plugin-host';
import { thirdPartyProviderSpecSchema, type ProviderSpec } from '@mcp/provider-sdk';

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

/**
 * Resolve the `ProviderSpec` for a kind — an enabled PLUGIN provider's spec wins
 * over a built-in of the same kind (mirrors how the registry override works), so
 * a plugin-contributed provider's live discovery is served too. Falls back to the
 * built-in spec. Best-effort: a snapshot read failure just uses the built-in.
 */
function resolveProviderSpec(kind: string): ProviderSpec | undefined {
  try {
    for (const ref of listProviderPlugins()) {
      for (const raw of ref.specs) {
        const parsed = thirdPartyProviderSpecSchema.safeParse(raw);
        if (parsed.success && parsed.data.kind === kind) return parsed.data as ProviderSpec;
      }
    }
  } catch {
    /* fall through to the built-in */
  }
  return getSpecByKind(kind);
}

export async function discoverModels(
  store: ProviderStore,
  cfg: ProviderConfig,
  previousEtag?: string | null,
): Promise<DiscoveryResult> {
  const spec = resolveProviderSpec(cfg.kind);
  if (spec?.discovery && spec.discovery.from !== 'static') {
    return engineDiscoverModels(spec, cfg, store, previousEtag ?? null);
  }
  throw new Error(`Live discovery not implemented for kind=${cfg.kind}`);
}
