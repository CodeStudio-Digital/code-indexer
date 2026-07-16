import type { ChatProvider } from './adapter.js';
import type { ResolvedCreds } from './credentials.js';
import type { ProviderAuthHandlers } from './auth.js';
import type {
  CreateCoderOpts,
  ProviderDiscoverModelsContext,
  ProviderDiscoveryResult,
  ProviderResolveCredentialsContext,
  ProviderTestContext,
} from './provider.js';

export type MaybePromise<T> = T | Promise<T>;

export interface ProviderAdapterClientContext {
  kind: string;
  creds: ResolvedCreds;
  model?: string;
}

export interface ProviderAdapterCoderContext extends ProviderAdapterClientContext {
  opts?: CreateCoderOpts;
}

/**
 * Executable V2 provider adapter exported by a provider plugin bundle.
 *
 * The host owns isolation, persistence and lifecycle. The plugin owns the
 * provider-specific code: credential resolution, refresh, model discovery,
 * connectivity checks and request/stream client construction.
 */
export interface ProviderRuntimeAdapter {
  sdkVersion: 2;
  /** Provider kind this adapter owns, e.g. `zai`, `copilot`, `bedrock`. */
  kind: string;
  /** Provider-owned OAuth/device/refresh/logout handlers. */
  authHandlers?: ProviderAuthHandlers;
  resolveCredentials?(ctx: ProviderResolveCredentialsContext): Promise<ResolvedCreds>;
  fetchModels?(ctx: ProviderAdapterClientContext): Promise<string[]>;
  discoverModels?(ctx: ProviderDiscoverModelsContext): Promise<ProviderDiscoveryResult>;
  testConnection?(ctx: ProviderTestContext): Promise<void>;
  createCoder?(ctx: ProviderAdapterCoderContext): MaybePromise<ChatProvider>;
}

export function defineProviderAdapter(adapter: ProviderRuntimeAdapter): ProviderRuntimeAdapter {
  return adapter;
}
