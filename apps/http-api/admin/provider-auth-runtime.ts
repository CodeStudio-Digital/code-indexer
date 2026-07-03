import { createHash, randomBytes } from 'node:crypto';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';
import type {
  LoopbackBinding,
  OAuthHostCapabilities,
  ProviderAuthContext,
  ProviderAuthHandlers,
  ProviderConfigLike,
  ProviderCredentials,
  StoredOAuth,
} from '@mcp/provider-sdk';
import { getDefinition } from '@mcp/services/providers/registry.js';

function toStoredOAuth(row: ReturnType<ProviderStore['getOAuth']>): StoredOAuth | null {
  if (!row) return null;
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
    scope: row.scope,
    extra: row.extra ?? {},
  };
}

function providerCredentials(store: ProviderStore, config: ProviderConfigLike): ProviderCredentials {
  return {
    async get() {
      return toStoredOAuth(store.getOAuth(config.id));
    },
    async set(tokens) {
      store.setOAuth({
        provider_id: config.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        scope: tokens.scope,
        extra: tokens.extra,
      });
    },
    async mirrorApiKey(token) {
      const latest = store.getProvider(config.id);
      if (!latest) throw new Error(`provider row '${config.id}' is not available`);
      store.upsertProvider({ ...latest, api_key: token });
    },
    async clear() {
      store.deleteOAuth(config.id);
    },
  };
}

function unsupported(name: string): never {
  throw new Error(`OAuth host capability '${name}' is not implemented in admin runtime yet`);
}

function oauthHostCapabilities(): OAuthHostCapabilities {
  return {
    pkce() {
      const verifier = base64url(randomBytes(32));
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      return { verifier, challenge, method: 'S256' };
    },
    stateHmac(payload) {
      return base64url(randomBytes(16)) + (payload ? `.${base64url(Buffer.from(payload))}` : '');
    },
    loopback(): Promise<LoopbackBinding> {
      unsupported('loopback');
    },
    openBrowser(): Promise<void> {
      unsupported('openBrowser');
    },
    deviceCode(): Promise<never> {
      unsupported('deviceCode');
    },
  };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function providerAuthContext(
  store: ProviderStore,
  config: ProviderConfig | ProviderConfigLike,
): ProviderAuthContext {
  return {
    config,
    fetch,
    credentials: providerCredentials(store, config),
    oauth: oauthHostCapabilities(),
    scheduleRefresh: () => {},
    log: (message) => console.warn(`[provider:${config.kind}] ${message}`),
  };
}

export function providerAuthHandlers(kind: string): ProviderAuthHandlers | null {
  return getDefinition(kind)?.authHandlers ?? null;
}

export function syntheticProviderConfig(input: {
  id: string;
  kind: string;
  name?: string;
  base_url?: string | null;
  api_key?: string | null;
  extra?: Record<string, unknown>;
}): ProviderConfigLike {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    base_url: input.base_url ?? null,
    api_key: input.api_key ?? null,
    extra: input.extra ?? {},
  };
}
