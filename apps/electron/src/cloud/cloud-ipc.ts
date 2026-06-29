/**
 * Cloud IPC root (main process). Wires the SecureTokenStore + TokenManager +
 * Transport, registers `cloud:fetch`/`cloud:auth-state`/`cloud:logout`, and is the
 * ONLY place tokens are handled: it intercepts the tokens that login/signup/2fa
 * return, persists them, and STRIPS them from the body before the renderer sees it.
 * The refresh token never crosses the IPC boundary.
 */
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { hostname, release } from 'node:os';
import type { CloudAuthState, CloudFetchResult, CloudOp } from '@mcp/api-bus';
import { ROUTE_MAP } from '@mcp/api-bus';
import { createSafeStorageTokenStore } from './secure-token-store.js';
import { createTokenManager, type RefreshOutcome } from './token-manager.js';
import { parseRefreshResponse } from './refresh-response.js';
import { createCloudTransport } from './cloud-transport.js';
import { cloudBaseUrl, portalUrl } from './cloud-config.js';
import {
  OAUTH_LOOPBACK_PORT,
  startOAuthLoopback,
  stopOAuthLoopback,
  registerAuthCapture,
  clearAuthCapture,
} from '../oauth-loopback.js';

const OAUTH_PROVIDERS = new Set(['google', 'github', 'microsoft']);
const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface SessionBody {
  account?: unknown;
  session?: { sessionId?: string; accessToken?: string; refreshToken?: string; accessExpiresIn?: number };
}

export function mountCloudIpc(): void {
  const baseUrl = cloudBaseUrl();
  const dir = path.join(app.getPath('userData'), 'cloud');
  const accountPath = path.join(dir, 'account.json');
  const store = createSafeStorageTokenStore({
    safeStorage,
    fs: {
      readFile: fsp.readFile,
      writeFile: fsp.writeFile,
      rm: (p) => fsp.rm(p, { force: true }),
      mkdir: (d) => fsp.mkdir(d, { recursive: true }).then(() => undefined),
    },
    filePath: path.join(dir, 'refresh.enc'),
    dir,
  });

  let currentAccount: CloudAuthState['account'] = null;
  const broadcast = (state: CloudAuthState) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('cloud:auth-changed', state);
  };

  // The account profile is NON-secret → cached as plain JSON beside refresh.enc,
  // so a restart restores the signed-in identity instantly (works offline). The
  // secret refresh token stays in the encrypted store.
  const saveAccount = async (acc: CloudAuthState['account']) => {
    if (!acc) return;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(accountPath, JSON.stringify(acc));
    } catch {
      /* best-effort cache */
    }
  };
  const loadAccount = async (): Promise<CloudAuthState['account']> => {
    try {
      return JSON.parse(await fsp.readFile(accountPath, 'utf8')) as CloudAuthState['account'];
    } catch {
      return null;
    }
  };
  const clearAccount = () => fsp.rm(accountPath, { force: true }).catch(() => {});

  const tokens = createTokenManager({
    store,
    now: () => Date.now(),
    onLoggedOut: () => {
      currentAccount = null;
      void clearAccount();
      broadcast({ state: 'logged_out', account: null });
    },
    refresh: async (rt): Promise<RefreshOutcome> => {
      const res = await fetch(`${baseUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!res) return { kind: 'offline' }; // network failure → keep the session, don't log out
      const body = await res.json().catch(() => ({}));
      return parseRefreshResponse(res.status, body);
    },
  });

  const transport = createCloudTransport({
    baseUrl,
    getAccessToken: () => tokens.getAccessToken(),
    invalidateAccess: () => tokens.invalidateAccess(),
    appVersion: app.getVersion(),
    os: `${process.platform}/${process.arch}`,
    deviceName: hostname(),
    osRelease: release(),
  });

  async function handleFetch(op: CloudOp, input: unknown): Promise<CloudFetchResult> {
    const route = ROUTE_MAP[op];
    if (!route) return { ok: false, status: 404, body: { code: 'unknown_op', message: 'Unknown cloud op.' } };
    const result = await transport.fetch(route, input);

    if (route.session === 'establish' && result.ok) {
      const b = result.body as SessionBody;
      const s = b.session;
      if (s?.accessToken && s.refreshToken) {
        await tokens.setSession(s.accessToken, s.accessExpiresIn ?? 600, s.refreshToken);
        currentAccount = (b.account as CloudAuthState['account']) ?? null;
        void saveAccount(currentAccount);
        broadcast({ state: 'logged_in', account: currentAccount });
        // Never forward the access/refresh tokens to the renderer.
        return { ...result, body: { account: b.account, session: { sessionId: s.sessionId, accessExpiresIn: s.accessExpiresIn } } };
      }
    }
    if (route.session === 'clear' && result.ok) {
      await tokens.clear();
      currentAccount = null;
      void clearAccount();
      broadcast({ state: 'logged_out', account: null });
    }
    return result;
  }

  // Validate + refresh the cached identity against the server. A dead/rotated
  // session is caught by the transport's 401 → single-flight refresh → onLoggedOut.
  async function hydrate(): Promise<void> {
    if (!(await tokens.isLoggedIn())) return;
    const res = await transport.fetch(ROUTE_MAP['auth.me'], undefined).catch(() => null);
    if (res && res.ok) {
      const acc = (res.body as { account?: CloudAuthState['account'] }).account ?? null;
      if (acc) {
        currentAccount = acc;
        await saveAccount(acc);
        broadcast({ state: 'logged_in', account: acc });
      }
    }
  }

  ipcMain.handle('cloud:fetch', (_e, op: CloudOp, input: unknown) => handleFetch(op, input));
  ipcMain.handle('cloud:auth-state', async (): Promise<CloudAuthState> => {
    if (!currentAccount) currentAccount = await loadAccount();
    if (!currentAccount && (await tokens.isLoggedIn())) {
      await hydrate(); // a token persists but no cached profile → fetch /me before answering
    } else if (currentAccount) {
      void hydrate(); // cached profile → answer instantly, validate in the background
    }
    const loggedIn = currentAccount != null || (await tokens.isLoggedIn());
    return { state: loggedIn ? 'logged_in' : 'logged_out', account: currentAccount };
  });
  ipcMain.handle('cloud:logout', async () => {
    await tokens.clear();
    currentAccount = null;
    void clearAccount();
    broadcast({ state: 'logged_out', account: null });
    return { ok: true };
  });

  // Browser handoff login (P7-B). Arm the loopback, open the given start URL in the
  // system browser, await the one-time handoff on 127.0.0.1:7878/cb, then redeem it
  // through the SAME establish path (handleFetch stores + broadcasts + strips
  // tokens). Shared by OAuth and org SSO — both end at the loopback handoff. No
  // tokens ever cross to the renderer; it only learns ok/error.
  async function runBrowserHandoffLogin(startUrl: string): Promise<{ ok: boolean; error?: string }> {
    const started = await startOAuthLoopback();
    if (!started.ok) return { ok: false, error: started.error ?? 'loopback_failed' };
    const handoff = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        clearAuthCapture();
        resolve(null);
      }, BROWSER_LOGIN_TIMEOUT_MS);
      timer.unref?.();
      registerAuthCapture((h) => {
        clearTimeout(timer);
        resolve(h);
      });
      void shell.openExternal(startUrl);
    });
    stopOAuthLoopback();
    if (!handoff) return { ok: false, error: 'login_timeout' };
    const res = await handleFetch('auth.oauthRedeem', { handoff });
    if (res.ok) {
      const win = BrowserWindow.getAllWindows()[0];
      win?.show();
      win?.focus();
      return { ok: true };
    }
    return { ok: false, error: (res.body as { code?: string })?.code ?? 'redeem_failed' };
  }

  ipcMain.handle('cloud:startBrowserLogin', async (_e, provider: string): Promise<{ ok: boolean; error?: string }> => {
    const id = String(provider || '');
    if (!OAUTH_PROVIDERS.has(id)) return { ok: false, error: 'unknown_provider' };
    return runBrowserHandoffLogin(`${baseUrl}/v1/auth/oauth/${id}/start?flow=desktop&port=${OAUTH_LOOPBACK_PORT}`);
  });

  // Enterprise SSO login: same loopback handoff, but the start URL is the org's
  // OIDC entry (the worker validates the org's entitlement + IdP). orgId is path-
  // segment-safe; we encode it regardless.
  ipcMain.handle('cloud:startSsoLogin', async (_e, orgId: string): Promise<{ ok: boolean; error?: string }> => {
    const id = String(orgId || '').trim();
    if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: 'invalid_org' };
    return runBrowserHandoffLogin(
      `${baseUrl}/v1/auth/sso/${encodeURIComponent(id)}/start?flow=desktop&port=${OAUTH_LOOPBACK_PORT}`,
    );
  });

  // Device login via the browser by ANY method (email/password OR OAuth): open the
  // web portal's /device bridge; after sign-in there it mints a handoff back to our
  // loopback. Lets users in WITHOUT OAuth secrets and without a password form here.
  ipcMain.handle('cloud:startPortalLogin', async (): Promise<{ ok: boolean; error?: string }> => {
    return runBrowserHandoffLogin(`${portalUrl()}/device?port=${OAUTH_LOOPBACK_PORT}`);
  });
}
