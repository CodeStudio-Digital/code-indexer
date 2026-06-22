/**
 * TokenManager — single-flight refresh + rotation. The one-shot refresh token
 * must never be presented twice concurrently, so N racing callers trigger exactly
 * ONE refresh. Token reuse forces a logout.
 */
import { describe, it, expect } from 'vitest';
import { createTokenManager, type RefreshOutcome } from '../token-manager.js';
import type { SecureTokenStore } from '../secure-token-store.js';

function fakeStore(initial: string | null = null): SecureTokenStore & { current: () => string | null } {
  let rt = initial;
  return {
    setRefreshToken: async (t) => { rt = t; },
    getRefreshToken: async () => rt,
    clear: async () => { rt = null; },
    isHardwareBacked: () => true,
    current: () => rt,
  };
}

describe('TokenManager', () => {
  it('returns the cached access token without refreshing while valid', async () => {
    let calls = 0;
    let now = 1000;
    const tm = createTokenManager({ store: fakeStore(), now: () => now, onLoggedOut: () => {}, refresh: async () => { calls++; return { kind: 'invalid' }; } });
    await tm.setSession('acc1', 600, 'rt1');
    expect(await tm.getAccessToken()).toBe('acc1');
    now += 100_000; // still within 600s minus skew
    expect(await tm.getAccessToken()).toBe('acc1');
    expect(calls).toBe(0);
  });

  it('refreshes via SINGLE FLIGHT when expired (N racers → 1 refresh)', async () => {
    let calls = 0;
    let now = 1000;
    const store = fakeStore('rt1');
    const tm = createTokenManager({
      store,
      now: () => now,
      onLoggedOut: () => {},
      refresh: async (rt): Promise<RefreshOutcome> => {
        calls++;
        expect(rt).toBe('rt1');
        return { kind: 'ok', accessToken: 'acc2', accessExpiresIn: 600, refreshToken: 'rt2' };
      },
    });
    await tm.setSession('acc1', 600, 'rt1');
    now += 10_000_000; // force expiry
    const [a, b, c] = await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
    expect([a, b, c]).toEqual(['acc2', 'acc2', 'acc2']);
    expect(calls).toBe(1); // one rotation, not three
    expect(store.current()).toBe('rt2'); // rotated token persisted
  });

  it('token reuse forces logout (clears store, fires onLoggedOut, returns null)', async () => {
    let loggedOut = '';
    const store = fakeStore('rt1');
    let now = 1000;
    const tm = createTokenManager({
      store,
      now: () => now,
      onLoggedOut: (r) => { loggedOut = r; },
      refresh: async (): Promise<RefreshOutcome> => ({ kind: 'reuse' }),
    });
    await tm.setSession('acc1', 600, 'rt1');
    now += 10_000_000;
    expect(await tm.getAccessToken()).toBeNull();
    expect(loggedOut).toBe('reuse');
    expect(store.current()).toBeNull();
  });

  it('no refresh token ⇒ getAccessToken is null (logged out)', async () => {
    const tm = createTokenManager({ store: fakeStore(null), now: () => 1, onLoggedOut: () => {}, refresh: async () => ({ kind: 'invalid' }) });
    expect(await tm.getAccessToken()).toBeNull();
    expect(await tm.isLoggedIn()).toBe(false);
  });
});
