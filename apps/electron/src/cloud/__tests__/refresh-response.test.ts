/**
 * Guards the exact bug that logged users out on every restart/new-window: the
 * /v1/auth/refresh response nests the rotated tokens under `session`, and the
 * parser used to read them at the top level → every refresh became `invalid`.
 * The fixture below is the REAL deployed-Worker response shape.
 */
import { describe, it, expect } from 'vitest';
import { parseRefreshResponse } from '../refresh-response.js';
import { createTokenManager } from '../token-manager.js';
import type { SecureTokenStore } from '../secure-token-store.js';

describe('parseRefreshResponse', () => {
  it('reads the rotated tokens from the nested `session` (real Worker shape)', () => {
    const body = {
      session: { sessionId: 'sid', accessToken: 'AT_new', refreshToken: 'RT_new', accessExpiresIn: 900, refreshExpiresIn: 2592000 },
    };
    expect(parseRefreshResponse(200, body)).toEqual({ kind: 'ok', accessToken: 'AT_new', refreshToken: 'RT_new', accessExpiresIn: 900 });
  });

  it('does NOT treat a top-level-token shape as ok (the old buggy assumption)', () => {
    // If the Worker ever flattened tokens, this must fail loudly, not silently log out.
    expect(parseRefreshResponse(200, { accessToken: 'x', refreshToken: 'y' }).kind).toBe('invalid');
  });

  it('maps reuse → reuse (theft), other 4xx → invalid', () => {
    expect(parseRefreshResponse(401, { code: 'token_reuse' }).kind).toBe('reuse');
    expect(parseRefreshResponse(401, { code: 'invalid_grant' }).kind).toBe('invalid');
  });

  it('treats network (0) and 5xx as offline → session is kept', () => {
    expect(parseRefreshResponse(0, {}).kind).toBe('offline');
    expect(parseRefreshResponse(503, {}).kind).toBe('offline');
  });
});

function fakeStore(initial: string | null): SecureTokenStore & { current: () => string | null } {
  let rt = initial;
  return {
    setRefreshToken: async (t) => { rt = t; },
    getRefreshToken: async () => rt,
    clear: async () => { rt = null; },
    isHardwareBacked: () => true,
    current: () => rt,
  };
}

describe('TokenManager × offline', () => {
  it('an offline refresh does NOT clear the session or log out', async () => {
    let loggedOut = false;
    const store = fakeStore('RT');
    const tm = createTokenManager({
      store,
      now: () => 0,
      onLoggedOut: () => { loggedOut = true; },
      refresh: async () => ({ kind: 'offline' }),
    });
    expect(await tm.getAccessToken()).toBeNull(); // no access this round
    expect(loggedOut).toBe(false); // but still logged in
    expect(store.current()).toBe('RT'); // refresh token preserved
    expect(await tm.isLoggedIn()).toBe(true);
  });
});
