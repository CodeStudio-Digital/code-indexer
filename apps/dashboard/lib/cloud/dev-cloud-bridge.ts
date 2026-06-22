/**
 * DEV-ONLY cloud bridge for browser `vite dev`, where there is no Electron main
 * process (and therefore no `electronAPI.cloud`). It talks to the Worker over
 * fetch and persists tokens in localStorage so a developer STAYS logged in across
 * reloads — the "knows you're logged in" experience, for the dev loop.
 *
 * Gated behind `import.meta.env.DEV` in cloud-client, so it is NEVER reachable in
 * the production bundle (which always uses the secure main-process bridge with
 * the OS keychain). INSECURE by design (localStorage) — acceptable for local dev
 * only. Requests are relative `/v1/...` → proxied to the Worker by Vite (no CORS).
 */
import type { CloudAuthState, CloudOp } from '@mcp/api-bus';
import { ROUTE_MAP } from '@mcp/api-bus';
import { CLOUD_API_BASE } from './cloud-config.js';

const LS_REFRESH = 'mcp-cloud-dev:refresh';
const LS_ACCESS = 'mcp-cloud-dev:access'; // JSON { token, expMs }
const LS_ACCOUNT = 'mcp-cloud-dev:account';

const ls = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  del: (k: string): void => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

interface CloudBridge {
  fetch(op: string, input: unknown): Promise<{ ok: boolean; status: number; body: unknown }>;
  getAuthState(): Promise<CloudAuthState>;
  logout(): Promise<{ ok: true }>;
  onAuthChanged(cb: (s: CloudAuthState) => void): (() => void) | void;
}

export function createDevCloudBridge(): CloudBridge {
  const listeners = new Set<(s: CloudAuthState) => void>();
  let inFlight: Promise<string | null> | null = null;

  const account = (): CloudAuthState['account'] => {
    const raw = ls.get(LS_ACCOUNT);
    try {
      return raw ? (JSON.parse(raw) as CloudAuthState['account']) : null;
    } catch {
      return null;
    }
  };
  const state = (): CloudAuthState => ({ state: ls.get(LS_REFRESH) ? 'logged_in' : 'logged_out', account: account() });
  const emit = (): void => {
    const s = state();
    for (const cb of listeners) cb(s);
  };
  const clearSession = (): void => {
    ls.del(LS_REFRESH);
    ls.del(LS_ACCESS);
    ls.del(LS_ACCOUNT);
  };

  async function http(method: string, path: string, body: unknown, bearer: string | null) {
    const headers: Record<string, string> = { 'x-cs-client': 'desktop-dev' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const init: RequestInit = { method, headers };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(`${CLOUD_API_BASE}${path}`, init);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: json };
  }

  async function doRefresh(): Promise<string | null> {
    const rt = ls.get(LS_REFRESH);
    if (!rt) return null;
    const r = await http('POST', '/v1/auth/refresh', { refreshToken: rt }, null).catch(() => null);
    // Rotated tokens are nested under `session` (same shape as login).
    const s = ((r?.body ?? {}) as { session?: { accessToken?: string; refreshToken?: string; accessExpiresIn?: number } }).session;
    if (r?.ok && s?.accessToken && s.refreshToken) {
      ls.set(LS_REFRESH, s.refreshToken);
      ls.set(LS_ACCESS, JSON.stringify({ token: s.accessToken, expMs: Date.now() + (s.accessExpiresIn ?? 0) * 1000 }));
      return s.accessToken;
    }
    // Only clear on a definitive auth rejection (4xx); never on network/5xx (offline).
    if (r && r.status >= 400 && r.status < 500) {
      clearSession();
      emit();
    }
    return null;
  }

  async function access(): Promise<string | null> {
    const raw = ls.get(LS_ACCESS);
    if (raw) {
      try {
        const { token, expMs } = JSON.parse(raw) as { token: string; expMs: number };
        if (token && Date.now() < expMs - 30_000) return token;
      } catch {
        /* fall through to refresh */
      }
    }
    if (!inFlight) inFlight = doRefresh().finally(() => (inFlight = null));
    return inFlight;
  }

  const fetchOp: CloudBridge['fetch'] = async (op, input) => {
    const route = ROUTE_MAP[op as CloudOp];
    if (!route) return { ok: false, status: 404, body: { code: 'unknown_op', message: 'Unknown cloud op.' } };
    const path = route.path((input ?? {}) as Record<string, unknown>);
    let bearer = route.auth === 'none' ? null : await access();
    if (route.auth === 'required' && !bearer) return { ok: false, status: 401, body: { code: 'auth_required' } };

    let res = await http(route.method, path, input, bearer).catch(() => ({ ok: false, status: 0, body: { code: 'offline' } }));
    if (res.status === 401 && route.auth !== 'none') {
      ls.del(LS_ACCESS);
      bearer = await access();
      if (bearer) res = await http(route.method, path, input, bearer).catch(() => res);
    }

    if (route.session === 'establish' && res.ok) {
      const b = res.body as { account?: unknown; session?: { accessToken?: string; refreshToken?: string; accessExpiresIn?: number; sessionId?: string } };
      const s = b.session;
      if (s?.accessToken && s.refreshToken) {
        ls.set(LS_REFRESH, s.refreshToken);
        ls.set(LS_ACCESS, JSON.stringify({ token: s.accessToken, expMs: Date.now() + (s.accessExpiresIn ?? 600) * 1000 }));
        if (b.account) ls.set(LS_ACCOUNT, JSON.stringify(b.account));
        emit();
        return { ok: true, status: res.status, body: { account: b.account, session: { sessionId: s.sessionId, accessExpiresIn: s.accessExpiresIn } } };
      }
    }
    if (route.session === 'clear' && res.ok) {
      clearSession();
      emit();
    }
    return res;
  };

  return {
    fetch: fetchOp,
    async getAuthState() {
      return state();
    },
    async logout() {
      try {
        await fetchOp('auth.logout', undefined);
      } catch {
        /* best-effort */
      }
      clearSession();
      emit();
      return { ok: true };
    },
    onAuthChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
