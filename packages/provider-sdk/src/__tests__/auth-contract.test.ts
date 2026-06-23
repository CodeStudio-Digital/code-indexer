import { describe, it, expect, vi } from 'vitest';
import { defineProvider } from '../provider.js';
import type {
  ProviderAuthContext,
  ProviderCredentials,
  OAuthHostCapabilities,
  StoredOAuth,
  DeviceCodeFlow,
} from '../auth.js';
import type { ProviderConfigLike } from '../credentials.js';

/** In-memory credential store implementing the host-side contract. */
function makeCredentials(): ProviderCredentials & { peek(): StoredOAuth | null } {
  let stored: StoredOAuth | null = null;
  let mirrored: string | null = null;
  return {
    get: async () => stored,
    set: async (t) => {
      stored = t;
    },
    mirrorApiKey: async (t) => {
      mirrored = t;
    },
    clear: async () => {
      stored = null;
      mirrored = null;
    },
    peek: () => stored,
  };
}

function makeOAuth(flow: DeviceCodeFlow): OAuthHostCapabilities {
  return {
    pkce: () => ({ verifier: 'verifier', challenge: 'challenge', method: 'S256' }),
    stateHmac: () => 'signed-state',
    loopback: async () => ({
      redirectUri: 'http://localhost:1455/cb',
      waitForCode: async () => ({ code: 'auth-code', state: 'signed-state' }),
      close() {},
    }),
    openBrowser: async () => {},
    deviceCode: async () => flow,
  };
}

function makeCtx(over: Partial<ProviderAuthContext> = {}): ProviderAuthContext {
  const config: ProviderConfigLike = { id: 'acme-1', kind: 'acme-oauth' };
  const tokens: StoredOAuth = { access_token: 'AT', refresh_token: 'RT', expires_at: 1, scope: 'llm' };
  const flow: DeviceCodeFlow = {
    userCode: 'WXYZ-1234',
    verificationUri: 'https://acme.example/device',
    interval: 5,
    expiresAt: 10_000,
    poll: async () => ({ status: 'authorized', tokens }),
  };
  return {
    config,
    fetch: globalThis.fetch,
    credentials: makeCredentials(),
    oauth: makeOAuth(flow),
    scheduleRefresh: vi.fn(),
    log: vi.fn(),
    ...over,
  };
}

// A device-code OAuth provider authored entirely against the host-capability
// contract — no per-kind core code. This is the shape Kimi migrates to.
const acmeOAuth = defineProvider({
  kind: 'acme-oauth',
  displayName: 'Acme OAuth',
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['acme-1'],
  pricing: {},
  auth: {
    mode: 'oauth',
    flavor: 'device-code',
    scopes: ['llm'],
    needs: { deviceCode: true, scheduledRefresh: true },
  },
  authHandlers: {
    async start(ctx) {
      const flow = await ctx.oauth.deviceCode({ startUrl: 'https://acme/device', clientId: 'acme' });
      return {
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        interval: flow.interval,
        state: { startedAt: flow.expiresAt },
      };
    },
    async poll(ctx) {
      const flow = await ctx.oauth.deviceCode({ startUrl: 'https://acme/device', clientId: 'acme' });
      const r = await flow.poll();
      if (r.status === 'authorized' && r.tokens) {
        await ctx.credentials.set(r.tokens);
        await ctx.credentials.mirrorApiKey(r.tokens.access_token);
        ctx.scheduleRefresh(Date.now() + 60_000);
        return { status: 'authorized' };
      }
      return { status: r.status };
    },
    async refresh(ctx) {
      const tok = await ctx.credentials.get();
      if (!tok) throw new Error('not connected');
      return { apiKey: tok.access_token, baseURL: 'https://acme/api' };
    },
    async logout(ctx) {
      await ctx.credentials.clear();
    },
  },
});

describe('OAuth host-capability contract', () => {
  it('declares its connect flow descriptively', () => {
    expect(acmeOAuth.auth?.mode).toBe('oauth');
    expect(acmeOAuth.auth?.flavor).toBe('device-code');
    expect(acmeOAuth.auth?.needs?.deviceCode).toBe(true);
  });

  it('start() surfaces the device code via the host capability', async () => {
    const ctx = makeCtx();
    const res = await acmeOAuth.authHandlers!.start!(ctx);
    expect(res.userCode).toBe('WXYZ-1234');
    expect(res.verificationUri).toBe('https://acme.example/device');
  });

  it('poll() persists tokens + mirrors the key + arms a refresh', async () => {
    const creds = makeCredentials();
    const ctx = makeCtx({ credentials: creds });
    const res = await acmeOAuth.authHandlers!.poll!(ctx, {});
    expect(res.status).toBe('authorized');
    expect(creds.peek()?.access_token).toBe('AT');
    expect(ctx.scheduleRefresh).toHaveBeenCalledOnce();
  });

  it('refresh() resolves runtime creds from stored tokens', async () => {
    const creds = makeCredentials();
    await creds.set({ access_token: 'AT2' });
    const ctx = makeCtx({ credentials: creds });
    const resolved = await acmeOAuth.authHandlers!.refresh!(ctx);
    expect(resolved.apiKey).toBe('AT2');
    expect(resolved.baseURL).toBe('https://acme/api');
  });

  it('logout() clears stored credentials', async () => {
    const creds = makeCredentials();
    await creds.set({ access_token: 'AT' });
    const ctx = makeCtx({ credentials: creds });
    await acmeOAuth.authHandlers!.logout!(ctx);
    expect(creds.peek()).toBeNull();
  });
});
