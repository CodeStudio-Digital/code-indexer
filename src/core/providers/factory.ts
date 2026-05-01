import type { LLMProvider, ChatProvider, ProviderDefinition, CreateCoderOpts } from './types.js';
import type { ProviderConfig } from '../../store/provider-store.js';
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
 * Resolve a provider by instance name. Four-branch lookup:
 *   1. name as ProviderStore instance (covers built-ins + custom admin rows)
 *   2. unnamed: pick is_default row from store
 *   3. name directly as a registry shape (no DB row — env var only)
 *   4. fallback: first shape whose envVar is set in process.env
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
        // Fall through to legacy paths if the default row has an unregistered kind.
      }
    }
  }

  // 3. Legacy: name matches a shape directly, no DB row.
  if (name) {
    const def = registry.get(name);
    if (def) return { def, cfg: null };
  }

  // 4. Last resort: first shape whose env var is set.
  for (const def of registry.values()) {
    if (def.envVars.some((v) => !!process.env[v])) return { def, cfg: null };
  }

  const knownEnv = [...registry.values()].flatMap((d) => d.envVars).join(', ');
  throw new Error(
    `No provider available. Configure one via the admin UI, pass -p <name>, ` +
      `or set one of: ${knownEnv}.`,
  );
}

export async function createIndexerProvider(
  name?: string,
  model?: string,
): Promise<LLMProvider> {
  const { def, cfg } = await lookupProvider(name);
  if (!def.createIndexer && !def.createIndexerAsync) {
    throw new Error(`Shape '${def.kind}' does not support the indexer`);
  }
  const creds = await resolveCreds(def, cfg);
  if (def.createIndexerAsync) return def.createIndexerAsync(creds, model);
  return def.createIndexer!(creds, model);
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
  return def.createCoder(creds, model, { ...opts, providerId: opts?.providerId ?? cfg?.id });
}

// ─── Back-compat re-exports ──────────────────────────────────────
// Existing call sites use createProviderAsync / createChatProviderAsync.
// Keep the names so we can migrate consumers incrementally.

export const createProviderAsync = createIndexerProvider;
export const createChatProviderAsync = createCoderProvider;

/** Synchronous counterpart — throws for OAuth/AWS shapes that need await. */
export function createProvider(name?: string, model?: string): LLMProvider {
  const registry = getRegistry();
  const store = getStore();

  // Only the ProviderStore lookup + env-var fallback — no OAuth refresh.
  let def: ProviderDefinition | undefined;
  let cfg: ProviderConfig | null = null;

  if (name && store) {
    const row = store.getProvider(name);
    if (row && row.enabled) {
      def = registry.get(effectiveKind(row));
      cfg = row;
    }
  }
  if (!def && name) def = registry.get(name);
  if (!def) {
    for (const d of registry.values()) {
      if (d.envVars.some((v) => !!process.env[v])) { def = d; break; }
    }
  }
  if (!def) throw new Error(`No provider available for name=${name ?? '(auto)'}`);

  if (def.credKind !== 'api-key') {
    throw new Error(
      `Shape '${def.kind}' requires async construction. Use createProviderAsync.`,
    );
  }
  if (!def.createIndexer) {
    throw new Error(`Shape '${def.kind}' does not support the indexer`);
  }
  const creds = {
    apiKey: cfg?.api_key ?? def.envVars.map((v) => process.env[v]).find(Boolean),
    baseURL: cfg?.base_url ?? def.defaultBaseURL,
  };
  return def.createIndexer(creds, model);
}

export {
  getDefinition,
  listDefinitions,
  getRegistry,
  listCoderKinds,
  listIndexerKinds,
} from './registry.js';
