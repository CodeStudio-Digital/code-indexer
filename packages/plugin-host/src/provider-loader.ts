/**
 * Provider-host loader — registers LLM providers contributed by enabled
 * plugins into the core provider registry.
 *
 * Unlike tools (sandboxed plugin worker, one-shot), a provider's adapter runs
 * IN-PROCESS on the agent's hot path and handles real credentials. So this
 * loader:
 *   1. discovers which enabled plugins contribute providers from the stored
 *      `.app.json` snapshot — WITHOUT importing any bundle;
 *   2. imports a bundle in-process ONLY when it passes the injected `trust`
 *      gate (first-party / pinned-key-signed — see the composition root);
 *   3. registers each `ProviderDefinition` via the injected `register`
 *      callback (e.g. `upsertProvider` from `@mcp/services`), so plugin-host
 *      stays decoupled from the provider registry.
 *
 * Adapter base classes (OpenAIChatProvider, …) are expected to be EXTERNAL in
 * a provider-plugin bundle and resolved from the host process at load time —
 * the host already depends on `@mcp/code-agent`, so an externalized import
 * binds to the host's module, not a second copy.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import type { ProviderDefinition } from '@mcp/provider-sdk';
import type { PluginModule } from '@mcp/plugin-sdk';
import { pluginDir } from './paths.js';

export interface ProviderPluginRef {
  namespace: string;
  /** Absolute path to the built worker bundle (default ESM export). */
  bundleFile: string;
  /** Provider kinds declared in the `.app.json` snapshot (cheap, pre-import). */
  providerKinds: string[];
  /** Ed25519 signature recorded at install (null when unsigned/local). */
  signature: string | null;
  /** Install source — 'market' | 'github' | 'local' | 'bundled' | … */
  source: string;
}

interface SnapshotProvider {
  kind: string;
}

/**
 * Enumerate enabled plugins that contribute at least one provider. Reads only
 * the stored snapshot — no bundle is imported, so this is safe to call before
 * any trust decision.
 */
export function listProviderPlugins(): ProviderPluginRef[] {
  const { dbPath } = loadConfig();
  const store = new InstalledPluginStore(dbPath);
  const out: ProviderPluginRef[] = [];
  try {
    for (const p of store.list({ enabled: true })) {
      const contrib = (p.contributions ?? {}) as {
        providers?: SnapshotProvider[];
        worker?: string | null;
      };
      const providers = Array.isArray(contrib.providers) ? contrib.providers : [];
      if (providers.length === 0 || !contrib.worker) continue;
      out.push({
        namespace: p.namespace,
        bundleFile: join(pluginDir(p.namespace), contrib.worker),
        providerKinds: providers.map((x) => x.kind),
        signature: p.signature,
        source: p.source,
      });
    }
  } finally {
    store.close();
  }
  return out;
}

export interface LoadPluginProvidersOptions {
  /** Register a contributed provider into the core registry (e.g. upsertProvider). */
  register: (def: ProviderDefinition) => void;
  /**
   * Trust gate. A provider adapter runs in-process with real credentials, so
   * only return true for bundles you trust (first-party / pinned-key signed).
   * Called per ref BEFORE its bundle is imported.
   */
  trust: (ref: ProviderPluginRef) => boolean;
  /** Override the discovery (tests). Defaults to {@link listProviderPlugins}. */
  refs?: ProviderPluginRef[];
  /** Override bundle import (tests). Defaults to a dynamic `import()`. */
  importBundle?: (file: string) => Promise<{ default?: PluginModule }>;
  /** Per-plugin error sink — a bad bundle skips that plugin, never throws. */
  onError?: (namespace: string, err: unknown) => void;
}

export interface LoadPluginProvidersResult {
  loaded: Array<{ namespace: string; kinds: string[] }>;
  /** Namespaces skipped — untrusted, or failed to import. */
  skipped: string[];
}

const defaultImportBundle = (file: string) =>
  import(pathToFileURL(file).href) as Promise<{ default?: PluginModule }>;

/**
 * Load + register providers contributed by trusted enabled plugins. Resilient:
 * an untrusted or broken plugin is skipped, never throws — a bad third-party
 * bundle must not take down provider resolution for the rest of the app.
 */
export async function loadPluginProviders(
  opts: LoadPluginProvidersOptions,
): Promise<LoadPluginProvidersResult> {
  const refs = opts.refs ?? listProviderPlugins();
  const importBundle = opts.importBundle ?? defaultImportBundle;
  const loaded: Array<{ namespace: string; kinds: string[] }> = [];
  const skipped: string[] = [];

  for (const ref of refs) {
    if (!opts.trust(ref)) {
      skipped.push(ref.namespace);
      continue;
    }
    try {
      const mod = await importBundle(ref.bundleFile);
      const providers = mod.default?.providers ?? [];
      const kinds: string[] = [];
      for (const def of providers) {
        opts.register(def);
        kinds.push(def.kind);
      }
      loaded.push({ namespace: ref.namespace, kinds });
    } catch (err) {
      opts.onError?.(ref.namespace, err);
      skipped.push(ref.namespace);
    }
  }

  return { loaded, skipped };
}
