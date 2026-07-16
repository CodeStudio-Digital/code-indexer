import type {
  ProviderAuthHandlers,
  ProviderDiscoverModelsContext,
  ProviderDiscoveryResult,
  ProviderRuntimeAdapter,
  ProviderSpec,
  ProviderResolveCredentialsContext,
  ResolvedCreds,
} from '@mcp/provider-sdk';
import { defineProviderAdapter } from '@mcp/provider-sdk';
import type { ProviderDefinition } from '@mcp/provider-sdk';

export interface ProviderAdapterFromSpecOptions {
  authHandlers?: ProviderAuthHandlers;
  resolveCredentials?(ctx: ProviderResolveCredentialsContext): Promise<ResolvedCreds>;
  discoverModels?(ctx: ProviderDiscoverModelsContext): Promise<ProviderDiscoveryResult>;
}

function resolveApiKeyCredentials(spec: ProviderSpec) {
  return async ({ config }: ProviderResolveCredentialsContext): Promise<ResolvedCreds> => ({
    apiKey: config.api_key ?? undefined,
    baseURL: config.base_url ?? spec.defaultBaseURL,
    extra: config.extra ?? undefined,
  });
}

/**
 * Compatibility bridge for first-party provider plugins migrating from
 * declarative ProviderSpec v1 to executable adapter v2.
 *
 * The plugin owns credential resolution through `resolveCredentials`; request
 * and streaming mechanics can still use the shared engine wire helpers, which
 * are SDK/runtime primitives rather than per-provider host switches.
 */
export function defineProviderAdapterFromSpec(
  spec: ProviderSpec,
  opts: ProviderAdapterFromSpecOptions = {},
): ProviderRuntimeAdapter {
  let defPromise: Promise<ProviderDefinition> | null = null;
  const definition = async (): Promise<ProviderDefinition> => {
    defPromise ??= import('./build-definition.js').then((m) => m.buildProviderDefinition(spec));
    return defPromise;
  };
  return defineProviderAdapter({
    sdkVersion: 2,
    kind: spec.kind,
    authHandlers: opts.authHandlers,
    resolveCredentials:
      opts.resolveCredentials ??
      (spec.credKind === 'api-key' ? resolveApiKeyCredentials(spec) : undefined),
    async fetchModels({ creds }) {
      const def = await definition();
      if (!def.fetchModels) return spec.defaultModels;
      return def.fetchModels(creds);
    },
    discoverModels: opts.discoverModels,
    async testConnection({ config, creds }) {
      const def = await definition();
      if (def.testConnection) await def.testConnection({ config, creds });
    },
    async createCoder({ creds, model, opts: coderOpts }) {
      const def = await definition();
      if (!def.createCoder) throw new Error(`Provider '${spec.kind}' does not support the coder`);
      return def.createCoder(creds, model, coderOpts);
    },
  });
}
