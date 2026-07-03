/**
 * Provider-host loader — registers LLM providers contributed DECLARATIVELY by
 * enabled plugins into the core provider registry.
 *
 * A plugin always authors a `ProviderSpec` as DATA in its `.app.json`. A
 * bundled first-party provider may also export an executable adapter V2 from
 * its worker bundle. This loader:
 *   1. reads the declared `ProviderSpec[]` from the stored snapshot;
 *   2. validates each against `thirdPartyProviderSpecSchema` — rejecting the
 *      host-only capabilities a third party must not claim (auth.hooks, the
 *      `sdk:*`/`chatgpt-models` discovery/test formats, unknown wires);
 *   3. turns the spec into either a declarative V1 `ProviderDefinition` via
 *      the injected `buildDefinition`, or a V2 plugin-owned proxy definition
 *      whose methods lazy-import the plugin adapter; and
 *   4. registers it via the injected `register` (e.g. `upsertProvider`).
 *
 * Because no bundle is executed, the old MCP_TRUSTED_PROVIDER_PLUGINS code-exec
 * gate is gone. What remains is a SOFT gate: an optional `trust` predicate and a
 * `reservedKinds` set so a plugin cannot shadow a built-in kind (e.g. spoof
 * 'anthropic' to point its baseURL/discovery at a hostile host). The wire is
 * constrained to the 6 known wires by the schema + `buildDefinition` (which
 * throws on an unknown wire) — the escape hatch is enforced fail-closed.
 */
import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import type { ProviderDefinition, ProviderSpec } from '@mcp/provider-sdk';
import { thirdPartyProviderSpecSchema, providerSpecSchema } from '@mcp/provider-sdk';
import { join } from 'node:path';
import { pluginDir } from './paths.js';
import { buildProviderPluginDefinition, type ProviderAdapterRuntimeRef } from './provider-adapter-definition.js';

export interface ProviderPluginRef {
  namespace: string;
  /** Declarative provider specs from the `.app.json` snapshot (DATA, pre-validation). */
  specs: unknown[];
  /** Ed25519 signature recorded at install (null when unsigned/local). */
  signature: string | null;
  /** Install source — 'market' | 'github' | 'local' | 'bundled' | … */
  source: string;
  /** Executable provider-adapter runtime, present for V2 plugin-owned providers. */
  runtime: ProviderAdapterRuntimeRef | null;
}

/**
 * Enumerate enabled plugins that contribute at least one provider spec. Reads
 * only the stored snapshot. V2 adapters are imported lazily later, when the
 * registered provider is actually used.
 */
export function listProviderPlugins(): ProviderPluginRef[] {
  const { dbPath } = loadConfig();
  const store = new InstalledPluginStore(dbPath);
  const out: ProviderPluginRef[] = [];
  try {
    for (const p of store.list({ enabled: true })) {
      const contrib = (p.contributions ?? {}) as {
        providers?: unknown[];
        worker?: string | null;
        providerRuntime?: { protocol?: string; entry?: string; kinds?: string[] } | null;
      };
      const specs = Array.isArray(contrib.providers) ? contrib.providers : [];
      if (specs.length === 0) continue;
      const runtime =
        contrib.providerRuntime?.protocol === 'provider-adapter-v2' &&
        Array.isArray(contrib.providerRuntime.kinds) &&
        contrib.providerRuntime.kinds.length > 0
          ? {
              namespace: p.namespace,
              file: join(pluginDir(p.namespace), contrib.providerRuntime.entry ?? contrib.worker ?? './dist/plugin.js'),
              kinds: contrib.providerRuntime.kinds,
            }
          : null;
      out.push({ namespace: p.namespace, specs, signature: p.signature, source: p.source, runtime });
    }
  } finally {
    store.close();
  }
  return out;
}

/**
 * First-party trust predicate: a provider plugin shipped INSIDE the app
 * (seeded with `source: 'bundled'`, see seedBundledPlugins) under the reserved
 * `provider-*` namespace. Such a plugin is validated against the full host
 * schema (may declare OAuth `auth.hooks` / `sdk:*` discovery) and is exempt from
 * `reservedKinds` (it legitimately owns its built-in kind). The bundled artifact
 * is trusted by provenance (it came from the app bundle); Ed25519-signature
 * verification is a future hardening for market/github first-party installs.
 */
export function isFirstPartyBundled(ref: ProviderPluginRef): boolean {
  return ref.source === 'bundled' && ref.namespace.startsWith('provider-');
}

export interface LoadPluginProvidersOptions {
  /** Register a built provider into the core registry (e.g. upsertProvider). */
  register: (def: ProviderDefinition) => void;
  /** Build a ProviderDefinition from a validated spec (provider-engine's buildProviderDefinition). */
  buildDefinition: (spec: ProviderSpec) => ProviderDefinition;
  /** Optional soft allow/deny per plugin (default: allow all). */
  trust?: (ref: ProviderPluginRef) => boolean;
  /**
   * First-party (bundled + blessed) predicate. A ref it returns true for is
   * validated against the FULL `providerSpecSchema` (may declare `auth.hooks`,
   * `sdk:*` discovery/test, `pat-exchange`) and is EXEMPT from `reservedKinds`
   * (a bundled `provider-copilot` legitimately owns kind `copilot`). Everything
   * else is validated against `thirdPartyProviderSpecSchema` — no host hooks.
   * Decided at install time (source 'bundled' + reserved namespace + signature),
   * not by the spec content. Default: nothing is first-party.
   */
  firstParty?: (ref: ProviderPluginRef) => boolean;
  /** Built-in kinds a plugin must NOT shadow. A spec whose kind is reserved is skipped. */
  reservedKinds?: ReadonlySet<string>;
  /** Override the discovery (tests). Defaults to {@link listProviderPlugins}. */
  refs?: ProviderPluginRef[];
  /** Per-spec error sink — a bad/invalid/reserved spec skips that provider, never throws. */
  onError?: (namespace: string, err: unknown) => void;
}

export interface LoadPluginProvidersResult {
  loaded: Array<{ namespace: string; kinds: string[] }>;
  /** Namespaces with at least one spec skipped (untrusted / invalid / reserved). */
  skipped: string[];
}

/**
 * Validate + build + register providers contributed by enabled plugins.
 * Declarative V1 stays DATA → buildDefinition → register. Bundled first-party
 * V2 becomes DATA → plugin-owned proxy definition → register; the bundle import
 * is lazy inside the definition methods. Resilient: an invalid spec, a
 * reserved-kind clash, or a buildDefinition throw skips that provider and
 * records the namespace — never takes down provider resolution for the rest of
 * the app.
 */
export function loadPluginProviders(opts: LoadPluginProvidersOptions): LoadPluginProvidersResult {
  const refs = opts.refs ?? listProviderPlugins();
  const loaded: Array<{ namespace: string; kinds: string[] }> = [];
  const skipped = new Set<string>();

  for (const ref of refs) {
    if (opts.trust && !opts.trust(ref)) {
      skipped.add(ref.namespace);
      continue;
    }
    // Blessed bundled plugins validate against the full host schema and own
    // their (otherwise reserved) kind; untrusted plugins get the third-party gate.
    const blessed = opts.firstParty?.(ref) ?? false;
    const schema = blessed ? providerSpecSchema : thirdPartyProviderSpecSchema;
    const kinds: string[] = [];
    for (const raw of ref.specs) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        opts.onError?.(ref.namespace, parsed.error);
        skipped.add(ref.namespace);
        continue;
      }
      const spec = parsed.data as ProviderSpec;
      if (!blessed && opts.reservedKinds?.has(spec.kind)) {
        opts.onError?.(ref.namespace, new Error(`provider kind '${spec.kind}' is reserved by a built-in`));
        skipped.add(ref.namespace);
        continue;
      }
      try {
        const useAdapter = blessed && ref.runtime?.kinds.includes(spec.kind);
        opts.register(useAdapter ? buildProviderPluginDefinition(spec, ref.runtime!) : opts.buildDefinition(spec));
        kinds.push(spec.kind);
      } catch (err) {
        opts.onError?.(ref.namespace, err);
        skipped.add(ref.namespace);
      }
    }
    if (kinds.length > 0) loaded.push({ namespace: ref.namespace, kinds });
  }

  return { loaded, skipped: [...skipped] };
}
