import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderDefinition } from '../../types.js';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

// getStore is the only DB seam — mock it so this runs with no better-sqlite3.
let fakeStore: unknown = null;
vi.mock('../store.js', () => ({ getStore: () => fakeStore }));

import { runOAuthRefresh } from '../oauth.js';

const cfg = { id: 'p1', kind: 'k', api_key: null, base_url: null, extra: {} } as unknown as ProviderConfig;

function def(over: Partial<ProviderDefinition['auth']> & { hooks?: string }): ProviderDefinition {
  return {
    kind: 'k',
    displayName: 'K',
    credKind: 'oauth',
    envVars: [],
    defaultModels: [],
    pricing: {},
    auth: { mode: 'oauth', ...over },
  } as ProviderDefinition;
}

describe('runOAuthRefresh — data-driven dispatch by spec.auth.hooks', () => {
  beforeEach(() => {
    fakeStore = null;
  });

  it('routes each hook to its hardened connector resolver (distinct error proves the route)', async () => {
    await expect(runOAuthRefresh(def({ hooks: 'copilot' }), cfg)).rejects.toThrow(/Copilot requires/);
    await expect(runOAuthRefresh(def({ hooks: 'chatgpt' }), cfg)).rejects.toThrow(/ChatGPT requires/);
    await expect(runOAuthRefresh(def({ hooks: 'google-oauth' }), cfg)).rejects.toThrow(/Google OAuth requires/);
    await expect(runOAuthRefresh(def({ hooks: 'claude-code' }), cfg)).rejects.toThrow(/Claude Code requires/);
    await expect(runOAuthRefresh(def({ hooks: 'kimi-code' }), cfg)).rejects.toThrow(/Kimi Code requires/);
  });

  it('a hookless provider falls through to the generic RFC path', async () => {
    await expect(
      runOAuthRefresh(def({ tokenUrl: 'https://t/token', clientId: 'cid' }), cfg),
    ).rejects.toThrow(/OAuth provider 'k' requires the ProviderStore/);
  });
});

describe('runOAuthRefresh — hookless generic RFC refresh', () => {
  it('refreshes near expiry, rotation-tolerant, mirrors api_key, returns Bearer creds', async () => {
    const setOAuth = vi.fn();
    const upsertProvider = vi.fn();
    fakeStore = {
      getOAuth: () => ({
        access_token: 'old',
        refresh_token: 'RT',
        expires_at: Date.now() - 1000, // expired → must refresh
        scope: 'sc',
        extra: { keep: 1 },
      }),
      setOAuth,
      upsertProvider,
    };

    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'NEW', expires_in: 3600 }), // no refresh_token → keep old
      text: async () => '',
    })) as unknown as typeof fetch;

    try {
      const creds = await runOAuthRefresh(
        def({ tokenUrl: 'https://t/token', clientId: 'cid', scopes: ['a', 'b'] }),
        { ...cfg, base_url: 'https://api.x' } as ProviderConfig,
      );
      expect(creds.apiKey).toBe('NEW');
      expect(creds.baseURL).toBe('https://api.x');
      expect(setOAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          access_token: 'NEW',
          refresh_token: 'RT', // rotation-tolerant: server omitted → keep old
          extra: expect.objectContaining({ keep: 1 }), // extra merged, not reset
        }),
      );
      expect(upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ api_key: 'NEW' }));
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('does NOT refresh when the token is comfortably valid', async () => {
    const setOAuth = vi.fn();
    fakeStore = {
      getOAuth: () => ({ access_token: 'live', refresh_token: 'RT', expires_at: Date.now() + 3_600_000 }),
      setOAuth,
      upsertProvider: vi.fn(),
    };
    const creds = await runOAuthRefresh(def({ tokenUrl: 'https://t/token', clientId: 'cid' }), cfg);
    expect(creds.apiKey).toBe('live');
    expect(setOAuth).not.toHaveBeenCalled();
  });
});
