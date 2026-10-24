/**
 * TokenManager — the SINGLE rotation authority for the cloud session. The refresh
 * token is one-shot rotating (server revokes the whole family on reuse), so two
 * concurrent requests must NEVER each present it. We keep the access token in
 * memory and coalesce every refresh onto ONE in-flight promise (single-flight),
 * so N callers that race an expiry trigger exactly one rotation. Pure logic with
 * injected deps → unit-tested. Lives in main; the renderer only ever asks for an
 * access token via IPC.
 */
import type { SecureTokenStore } from './secure-token-store.js';

export interface RefreshOutcome {
  /** 'offline' = transient network/5xx → keep the session (do NOT log out). */
  kind: 'ok' | 'reuse' | 'invalid' | 'offline';
  accessToken?: string;
  accessExpiresIn?: number; // seconds
  refreshToken?: string; // the NEW rotated token
}

interface TokenManagerDeps {
  store: SecureTokenStore;
  /** Calls POST /v1/auth/refresh with the current refresh token. */
  refresh: (refreshToken: string) => Promise<RefreshOutcome>;
  now: () => number; // ms
  /** Broadcast a forced logout (token reuse / invalid) to the renderer windows. */
  onLoggedOut: (reason: string) => void;
}

const SKEW_MS = 30_000; // refresh ~30s before the access token actually expires

export function createTokenManager(deps: TokenManagerDeps) {
  let memAccess: string | null = null;
  let memExpMs = 0;
  let inFlight: Promise<string | null> | null = null;

  async function doRefresh(): Promise<string | null> {
    const rt = await deps.store.getRefreshToken();
    if (!rt) return null; // not logged in
    const r = await deps.refresh(rt);
    if (r.kind === 'offline') {
      // Transient network/server failure — DON'T clear the session. The caller
      // gets no access token this round but stays logged in (cached identity).
      return null;
    }
    if (r.kind !== 'ok' || !r.accessToken || !r.refreshToken) {
      await deps.store.clear();
      memAccess = null;
      memExpMs = 0;
      deps.onLoggedOut(r.kind); // 'reuse' (theft) | 'invalid'
      return null;
    }
    await deps.store.setRefreshToken(r.refreshToken); // persist the NEW token immediately
    memAccess = r.accessToken;
    memExpMs = deps.now() + (r.accessExpiresIn ?? 0) * 1000;
    return memAccess;
  }

  return {
    /** After a successful login: cache the access token + persist the refresh token. */
    async setSession(accessToken: string, accessExpiresIn: number, refreshToken: string): Promise<void> {
      memAccess = accessToken;
      memExpMs = deps.now() + accessExpiresIn * 1000;
      await deps.store.setRefreshToken(refreshToken);
    },

    /** A fresh access token, refreshing via single-flight if needed. null ⇒ logged out. */
    async getAccessToken(): Promise<string | null> {
      if (memAccess && deps.now() < memExpMs - SKEW_MS) return memAccess;
      if (!inFlight) inFlight = doRefresh().finally(() => (inFlight = null));
      return inFlight;
    },

    /** Force a refresh on the next call (e.g. after a 401 on a non-expired token). */
    invalidateAccess(): void {
      memAccess = null;
      memExpMs = 0;
    },

    async isLoggedIn(): Promise<boolean> {
      if (memAccess) return true;
      return (await deps.store.getRefreshToken()) != null;
    },

    async clear(): Promise<void> {
      memAccess = null;
      memExpMs = 0;
      await deps.store.clear();
    },
  };
}

type TokenManager = ReturnType<typeof createTokenManager>;
