import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { kimiCodeOAuthRouter } from '@apps/http-api/admin/oauth-kimi-code.routes.js';
import { discoverKimiCodeModels } from '@mcp/provider-engine/discovery/kimi-code-models.js';
import { kimiCodeSpec } from '@mcp/provider-engine/specs/kimi.js';
import { __setStoreForTests } from '@mcp/services/providers/shared/store.js';
import {
  __setKimiCodeFetchForTests,
  __setRefreshTombstoneCooldownForTests,
  __setRaceRecoveryDelayForTests,
  __clearRejectedRefreshTokensForTests,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_CLIENT_ID,
  fetchKimiCodeModels,
  refreshIfExpired,
  startDeviceFlow,
  pollDeviceFlow,
} from '@mcp/services/services/oauth/kimi-code.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Kimi Code OAuth service', () => {
  afterEach(() => {
    __setKimiCodeFetchForTests(null);
  });

  it('start returns verification URL, user code, device code, and sends kimi-cli headers', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    __setKimiCodeFetchForTests(async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        device_code: 'device-123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.kimi.com/device',
        verification_uri_complete: 'https://auth.kimi.com/device?user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 1,
      });
    });

    const flow = await startDeviceFlow();

    expect(flow.verification_url).toBe('https://auth.kimi.com/device');
    expect(flow.user_code).toBe('ABCD-EFGH');
    expect(flow.device_code).toBe('device-123');
    const body = requests[0].init?.body as URLSearchParams;
    expect(body.get('client_id')).toBe(KIMI_CODE_CLIENT_ID);
    const headers = new Headers(requests[0].init?.headers);
    expect(headers.get('X-Msh-Platform')).toBe('kimi_cli');
    expect(headers.get('X-Msh-Version')).toBe('1.36.0');
    expect(headers.get('User-Agent')).toBe('KimiCLI/1.36.0');
    expect(headers.get('X-Msh-Device-Id')).toBeTruthy();
  });

  it('poll returns pending while authorization is not complete', async () => {
    let calls = 0;
    __setKimiCodeFetchForTests(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          device_code: 'device-123',
          user_code: 'ABCD',
          verification_uri: 'https://auth.kimi.com/device',
          interval: 1,
        });
      }
      return jsonResponse({ error: 'authorization_pending' }, 400);
    });

    const flow = await startDeviceFlow();
    const result = await pollDeviceFlow(flow.state);

    expect(result.status).toBe('pending');
  });
});

describe('Kimi Code OAuth admin route', () => {
  let dir: string;
  let db: CodeIndexDB;
  let store: ProviderStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-code-oauth-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    store = new ProviderStore(db.raw());
  });

  afterEach(() => {
    __setKimiCodeFetchForTests(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('poll authorized saves provider, tokens, and discovered models', async () => {
    const fetchCalls: string[] = [];
    __setKimiCodeFetchForTests(async (url) => {
      const asString = String(url);
      fetchCalls.push(asString);
      if (asString.endsWith('/device_authorization')) {
        return jsonResponse({
          device_code: 'device-123',
          user_code: 'ABCD',
          verification_uri: 'https://auth.kimi.com/device',
          interval: 1,
        });
      }
      if (asString.endsWith('/api/oauth/token')) {
        return jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          scope: 'openid profile',
          token_type: 'Bearer',
        });
      }
      if (asString.endsWith('/models')) {
        return jsonResponse({
          data: [
            {
              id: 'kimi-k2.6',
              display_name: 'Kimi K2.6',
              context_length: 262144,
              supports_reasoning: true,
              supports_image_in: true,
              supports_video_in: true,
            },
          ],
        });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const app = kimiCodeOAuthRouter(store);
    const started = await app.request('/oauth/kimi-code/start', { method: 'POST' });
    const startBody = await started.json() as { state: string };
    const polled = await app.request('/oauth/kimi-code/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: startBody.state }),
    });
    const pollBody = await polled.json() as { status: string; model_count?: number };

    expect(pollBody.status).toBe('authorized');
    expect(pollBody.model_count).toBe(1);
    const provider = store.getProvider('kimi-code')!;
    expect(provider.kind).toBe('kimi-code');
    expect(provider.auth_mode).toBe('oauth');
    expect(provider.base_url).toBe(KIMI_CODE_BASE_URL);
    expect(provider.api_key).toBe('access-token');
    expect(provider.use_for_agent).toBe(true);
    expect(provider.use_for_coder).toBe(true);
    expect(provider.extra.client_id).toBe(KIMI_CODE_CLIENT_ID);

    const oauth = store.getOAuth('kimi-code')!;
    expect(oauth.access_token).toBe('access-token');
    expect(oauth.refresh_token).toBe('refresh-token');
    expect(oauth.extra.device_id).toBeTruthy();

    const models = store.listModels('kimi-code');
    expect(models).toHaveLength(1);
    expect(models[0].model_id).toBe('kimi-k2.6');
    expect(models[0].context_window).toBe(262144);
    expect(models[0].can_reason).toBe(true);
    expect(models[0].input_modalities).toEqual(['text', 'image', 'video']);
    expect(fetchCalls.some((url) => url.endsWith('/models'))).toBe(true);
  });
});

describe('Kimi Code model discovery and refresh', () => {
  let dir: string;
  let db: CodeIndexDB;
  let store: ProviderStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-code-discovery-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    store = new ProviderStore(db.raw());
    store.upsertProvider({
      id: 'kimi-code',
      name: 'Kimi Code',
      kind: 'kimi-code',
      base_url: KIMI_CODE_BASE_URL,
      api_key: 'old-access',
      auth_mode: 'oauth',
      extra: { device_id: 'device-id' },
    });
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'old-access',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 10 * 60_000,
      scope: 'openid',
      extra: { device_id: 'device-id' },
    });
    __setStoreForTests(store);
  });

  afterEach(() => {
    __setStoreForTests(null);
    __setKimiCodeFetchForTests(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps /models fields and falls back to seeds on failure', async () => {
    __setKimiCodeFetchForTests(async (url) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({
          data: [
            {
              id: 'kimi-k2-thinking',
              display_name: 'Kimi Thinking',
              context_length: 131072,
              supports_reasoning: true,
              supports_image_in: false,
              supports_video_in: true,
            },
          ],
        });
      }
      return jsonResponse({}, 500);
    });

    const models = await discoverKimiCodeModels(kimiCodeSpec, store.getProvider('kimi-code')!, store);
    expect(models).toHaveLength(1);
    expect(models[0].description).toContain('always_thinking');
    expect(models[0].input_modalities).toEqual(['text', 'image', 'video']);

    __setKimiCodeFetchForTests(async () => jsonResponse({ error: 'down' }, 502));
    const fallback = await discoverKimiCodeModels(kimiCodeSpec, store.getProvider('kimi-code')!, store);
    expect(fallback.map((m) => m.model_id)).toContain('kimi-k2.6');
  });

  it('401 during model discovery forces refresh and retries', async () => {
    const headersSeen: Array<string | null> = [];
    __setKimiCodeFetchForTests(async (url, init) => {
      const asString = String(url);
      if (asString.endsWith('/models')) {
        const headers = new Headers(init?.headers);
        headersSeen.push(headers.get('Authorization'));
        expect(headers.get('X-Msh-Platform')).toBe('kimi_cli');
        expect(headers.get('User-Agent')).toBe('KimiCLI/1.36.0');
        if (headersSeen.length === 1) return jsonResponse({ error: 'expired' }, 401);
        return jsonResponse({ data: [{ id: 'kimi-k2.6', context_length: 262144 }] });
      }
      if (asString.endsWith('/api/oauth/token')) {
        return jsonResponse({
          access_token: 'fresh-access',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        });
      }
      return jsonResponse({}, 500);
    });

    const models = await discoverKimiCodeModels(kimiCodeSpec, store.getProvider('kimi-code')!, store);
    expect(models[0].model_id).toBe('kimi-k2.6');
    expect(headersSeen).toEqual(['Bearer old-access', 'Bearer fresh-access']);
    expect(store.getProvider('kimi-code')?.api_key).toBe('fresh-access');
  });

  it('tombstones a refresh_token rejected with 401 and skips network on the next call', async () => {
    __setRefreshTombstoneCooldownForTests(60_000); // long enough that it stays active for the second call
    __setRaceRecoveryDelayForTests(0); // skip the 1s race-recovery sleep
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'expired-access',
      refresh_token: 'dead-refresh',
      expires_at: Date.now() - 1000,
      scope: 'openid',
      extra: { device_id: 'device-id' },
    });

    let calls = 0;
    __setKimiCodeFetchForTests(async () => {
      calls++;
      return jsonResponse({ error: 'invalid_grant', error_description: 'revoked' }, 401);
    });

    await expect(refreshIfExpired(store, 'kimi-code')).rejects.toThrow(/revoked|HTTP 401/i);
    expect(calls).toBe(1);

    // Second call within the cooldown window: returns the cached access_token
    // without hitting /oauth/token at all.
    const second = await refreshIfExpired(store, 'kimi-code');
    expect(second).toBe('expired-access');
    expect(calls).toBe(1);

    // `force` bypasses the tombstone — the caller (e.g. a 401 handler from the
    // LLM side) can still demand a refresh attempt.
    await expect(refreshIfExpired(store, 'kimi-code', { force: true })).rejects.toThrow();
    expect(calls).toBe(2);

    __setRefreshTombstoneCooldownForTests(null);
    __setRaceRecoveryDelayForTests(null);
    __clearRejectedRefreshTokensForTests();
  });

  it('tombstone clears when the persisted refresh_token has been rotated externally', async () => {
    __setRefreshTombstoneCooldownForTests(60_000);
    __setRaceRecoveryDelayForTests(0);
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'expired-access',
      refresh_token: 'dead-refresh',
      expires_at: Date.now() - 1000,
      scope: 'openid',
      extra: { device_id: 'device-id' },
    });

    let calls = 0;
    __setKimiCodeFetchForTests(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ error: 'invalid_grant' }, 401);
      return jsonResponse({
        access_token: 'newly-issued',
        refresh_token: 'rotated-refresh',
        expires_in: 7200,
        scope: 'openid',
        token_type: 'Bearer',
      });
    });

    await expect(refreshIfExpired(store, 'kimi-code')).rejects.toThrow();

    // Simulate /login (or another process) rotating the refresh_token. The
    // tombstone is keyed on the old value, so the next call should bypass it.
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'expired-access',
      refresh_token: 'fresh-from-relogin',
      expires_at: Date.now() - 1000,
      scope: 'openid',
      extra: { device_id: 'device-id' },
    });

    const result = await refreshIfExpired(store, 'kimi-code');
    expect(result).toBe('newly-issued');
    expect(calls).toBe(2);

    __setRefreshTombstoneCooldownForTests(null);
    __setRaceRecoveryDelayForTests(null);
    __clearRejectedRefreshTokensForTests();
  });

  it('on 401 picks up an in-flight rotated token persisted by another process', async () => {
    __setRaceRecoveryDelayForTests(0);
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'expired-access',
      refresh_token: 'our-refresh',
      expires_at: Date.now() - 1000,
      scope: 'openid',
      extra: { device_id: 'device-id' },
    });

    __setKimiCodeFetchForTests(async () => {
      // Simulate another process rotating the token before we re-read.
      store.setOAuth({
        provider_id: 'kimi-code',
        access_token: 'rotated-by-other-process',
        refresh_token: 'rotated-refresh',
        expires_at: Date.now() + 30 * 60_000,
        scope: 'openid',
        extra: { device_id: 'device-id' },
      });
      return jsonResponse({ error: 'invalid_grant' }, 401);
    });

    const result = await refreshIfExpired(store, 'kimi-code');
    expect(result).toBe('rotated-by-other-process');
    // Tombstone must not be set — the 401 was the loser of a benign race,
    // not an actual rejection of the live refresh_token.
    __setRaceRecoveryDelayForTests(null);
    __clearRejectedRefreshTokensForTests();
  });

  it('adaptive threshold: long expires_in triggers refresh earlier than the 5min floor', async () => {
    // expires_in = 7200s (2h) → threshold = 3600s = 60min.
    // Token has 50min remaining, which is BELOW threshold → refresh fires.
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'expired-access',
      refresh_token: 'rt',
      expires_at: Date.now() + 50 * 60_000,
      scope: 'openid',
      extra: { device_id: 'device-id', expires_in: 7200 },
    });

    let called = false;
    __setKimiCodeFetchForTests(async () => {
      called = true;
      return jsonResponse({
        access_token: 'fresh-from-adaptive',
        refresh_token: 'rt2',
        expires_in: 7200,
      });
    });

    const result = await refreshIfExpired(store, 'kimi-code');
    expect(called).toBe(true);
    expect(result).toBe('fresh-from-adaptive');
  });

  it('adaptive threshold: missing expires_in falls back to the 5min floor', async () => {
    // 6 minutes remaining + no expires_in → threshold is 5min (default) →
    // the 6min remaining is ABOVE threshold → no refresh fires.
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'still-valid',
      refresh_token: 'rt',
      expires_at: Date.now() + 6 * 60_000,
      scope: 'openid',
      extra: { device_id: 'device-id' },
    });

    let called = false;
    __setKimiCodeFetchForTests(async () => {
      called = true;
      return jsonResponse({ access_token: 'should-not-be-fetched' });
    });

    const result = await refreshIfExpired(store, 'kimi-code');
    expect(called).toBe(false);
    expect(result).toBe('still-valid');
  });

  it('refresh renews access and refresh tokens and updates api_key mirror', async () => {
    store.setOAuth({
      provider_id: 'kimi-code',
      access_token: 'expired-access',
      refresh_token: 'old-refresh',
      expires_at: Date.now() - 1000,
      scope: 'openid',
      extra: { device_id: 'device-id' },
    });
    __setKimiCodeFetchForTests(async () => jsonResponse({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 7200,
      scope: 'openid email',
      token_type: 'Bearer',
    }));

    const token = await refreshIfExpired(store, 'kimi-code');

    expect(token).toBe('new-access');
    expect(store.getProvider('kimi-code')?.api_key).toBe('new-access');
    const oauth = store.getOAuth('kimi-code')!;
    expect(oauth.refresh_token).toBe('new-refresh');
    expect(oauth.scope).toBe('openid email');
    expect(oauth.extra.expires_in).toBe(7200);
  });

  it('fetchKimiCodeModels reads data array from coding/v1 /models', async () => {
    __setKimiCodeFetchForTests(async (url, init) => {
      expect(String(url)).toBe(`${KIMI_CODE_BASE_URL}/models`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
      expect(new Headers(init?.headers).get('X-Msh-Platform')).toBeNull();
      return jsonResponse({ data: [{ id: 'kimi-k2.6' }] });
    });

    await expect(fetchKimiCodeModels({ apiKey: 'token' })).resolves.toEqual([
      { id: 'kimi-k2.6' },
    ]);
  });
});
