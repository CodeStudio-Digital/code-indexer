/**
 * Live model discovery dispatcher.
 *
 * Plugin-first: when the registered provider definition exposes executable
 * discovery, delegate to the plugin adapter. Otherwise fall back to the legacy
 * spec-driven `@mcp/provider-engine` dispatcher, which keeps existing providers
 * working while they migrate ownership into their own bundles.
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
import {
  listProviderPlugins,
  isFirstPartyBundled,
  isProviderPluginMethodNotImplementedError,
} from '@mcp/plugin-host';
import { thirdPartyProviderSpecSchema, providerSpecSchema, type ProviderSpec } from '@mcp/provider-sdk';
import { getDefinition } from '@mcp/services/providers/registry.js';
import { resolveCreds } from '@mcp/services/providers/shared/resolver.js';

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
export function resolveProviderSpec(kind: string): ProviderSpec | undefined {
  try {
    for (const ref of listProviderPlugins()) {
      // First-party bundled refs may declare host capabilities (sdk:* discovery,
      // auth.hooks) — validate with the full schema, mirroring the provider
      // loader. Without this, a bundled OAuth connector's spec fails the
      // third-party parse and its live discovery would fall closed once it
      // leaves BUILTIN_SPECS.
      const schema = isFirstPartyBundled(ref) ? providerSpecSchema : thirdPartyProviderSpecSchema;
      for (const raw of ref.specs) {
        const parsed = schema.safeParse(raw);
        if (parsed.success && parsed.data.kind === kind) return parsed.data as ProviderSpec;
      }
    }
  } catch {
    /* fall through to the built-in */
  }
  return getSpecByKind(kind);
}

async function discoverViaProviderDefinition(
  cfg: ProviderConfig,
  previousEtag?: string | null,
): Promise<DiscoveryResult | null> {
  const def = getDefinition(cfg.kind);
  if (!def?.discoverModels) return null;

  try {
    const creds = await resolveCreds(def, cfg);
    const result = await def.discoverModels({
      config: cfg,
      creds,
      previousEtag: previousEtag ?? null,
      fetch,
      log: (message) => console.warn(`[provider:${cfg.kind}] ${message}`),
    });
    return {
      models: result.models as UpsertModelInput[],
      etag: result.etag ?? null,
      notModified: result.notModified ?? false,
    };
  } catch (err) {
    if (isProviderPluginMethodNotImplementedError(err)) return null;
    throw err;
  }
}

export async function discoverModels(
  store: ProviderStore,
  cfg: ProviderConfig,
  previousEtag?: string | null,
): Promise<DiscoveryResult> {
  const pluginResult = await discoverViaProviderDefinition(cfg, previousEtag);
  if (pluginResult) return pluginResult;

  const spec = resolveProviderSpec(cfg.kind);
  if (spec?.discovery && spec.discovery.from !== 'static') {
    return engineDiscoverModels(spec, cfg, store, previousEtag ?? null);
  }
  throw new Error(`Live discovery not implemented for kind=${cfg.kind}`);
}
