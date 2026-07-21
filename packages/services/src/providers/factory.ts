import type { ChatProvider, ProviderDefinition, CreateCoderOpts } from './types.js';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { withReasoningCapabilities, withStreamResilience } from '@mcp/provider-sdk';
import { getRegistry, getDefinition } from './registry.js';
import { getStore } from './shared/store.js';
import { resolveCreds } from './shared/resolver.js';

export interface LookupResult {
  def: ProviderDefinition;
  cfg: ProviderConfig | null;
}

/**
 * Legacy ProviderStore rows encoded Z.AI as `kind='openai'` with the marker
 * `extra.zai_has_coding_mode=true` (because the old coder factory had no
 * dedicated ZAI case in its switch — it detected this flag inside the
 * OpenAI branch). New seeds use `kind='zai'` directly, but existing DBs
 * need this rewrite so dispatch reaches the proper ZAI definition.
 */
function effectiveKind(cfg: ProviderConfig): string {
  if (cfg.kind === 'openai' && (cfg.id === 'zai' || cfg.extra?.zai_has_coding_mode === true)) {
    return 'zai';
  }
  if (
    cfg.kind === 'openai'
    && cfg.id === 'kimi-code'
    && (
      cfg.base_url?.replace(/\/$/, '').toLowerCase() === 'https://api.kimi.com/coding/v1'
      || cfg.extra?.oauth_key === 'oauth/kimi-code'
    )
  ) {
    return 'kimi-code';
  }
  return cfg.kind;
}

function lookupByCfg(
  registry: Map<string, ProviderDefinition>,
  cfg: ProviderConfig,
  hint: string,
): LookupResult {
  const kind = effectiveKind(cfg);
  const def = registry.get(kind);
  if (!def) {
    throw new Error(
      `Instance '${hint}' declares kind='${cfg.kind}', but that shape is not ` +
        `registered. Available shapes: ${[...registry.keys()].join(', ')}.`,
    );
  }
  return { def, cfg };
}

/**
 * Resolve a provider by instance name. Three-branch lookup:
 *   1. name as ProviderStore instance (covers built-ins + custom admin rows)
 *   2. unnamed: pick is_default row from store
 *   3. name directly as a registry shape (no DB row — yields no credential)
 *
 * Credentials never come from the environment: there is no env-var fallback
 * branch. With no configured row, dispatch fails with a clear "configure a
 * provider" error instead of silently activating a provider from an env token.
 *
 * This is the single entry point that reconciles shapes (registry) with
 * instances (ProviderStore), so custom providers added via the admin UI
 * dispatch through the same path as built-ins.
 */
export async function lookupProvider(name?: string): Promise<LookupResult> {
  const store = getStore();
  const registry = getRegistry();

  // 1. Name is an instance id in the ProviderStore.
  if (name && store) {
    const cfg = store.getProvider(name);
    if (cfg && cfg.enabled) return lookupByCfg(registry, cfg, name);
  }

  // 2. Unnamed: pick the default-flagged row.
  if (!name && store) {
    const rows = store.listProviders({ enabled: true, use_for_agent: true });
    const defRow = rows.find((r) => r.is_default) ?? rows[0];
    if (defRow) {
      try {
        return lookupByCfg(registry, defRow, defRow.id);
      } catch {
        // Fall through to the shape lookup if the default row has an unregistered kind.
      }
    }
  }

  // 3. Legacy: name matches a shape directly, no DB row (no credential).
  if (name) {
    const def = registry.get(name);
    if (def) return { def, cfg: null };
  }

  throw new Error(
    `No provider available. Configure one via the admin UI or pass -p <name>.`,
  );
}

export async function createCoderProvider(
  name?: string,
  model?: string,
  opts?: CreateCoderOpts,
): Promise<ChatProvider> {
  const { def, cfg } = await lookupProvider(name);
  if (!def.createCoder) {
    throw new Error(`Shape '${def.kind}' does not support the coder`);
  }
  const creds = await resolveCreds(def, cfg);
  const providerId = opts?.providerId ?? cfg?.id;
  const store = getStore();
  const providerModels = opts?.providerModels ?? (store && providerId ? store.listModels(providerId) : undefined);
  // Central stream-resilience for EVERY coder provider (legacy `defineProvider`
  // AND engine-built). Node 24 (Electron 42) makes node-fetch@2 — the HTTP layer
  // of the OpenAI SDK — throw `ERR_STREAM_PREMATURE_CLOSE` on the benign trailing
  // socket teardown AFTER a stream already completed. withStreamResilience
  // swallows that post-`done` close and re-throws genuine mid-stream truncations.
  return withStreamResilience(
    withReasoningCapabilities(
      def.createCoder(creds, model, { ...opts, providerId, providerModels }),
      providerModels,
      model,
    ),
  );
}

// ─── Back-compat re-exports ──────────────────────────────────────
// Existing coder call sites use createChatProviderAsync.
export const createChatProviderAsync = createCoderProvider;

export { createImagesProvider } from './images-factory.js';

export {
  getDefinition,
  listDefinitions,
  getRegistry,
  listCoderKinds,
} from './registry.js';
