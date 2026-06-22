/**
 * Low-level HTTPS transport to the cloud Worker. Attaches the access token, the
 * client headers, and a timeout; on a 401 for an authed route it invalidates the
 * cached token and retries ONCE through the single-flight refresh. A 401 means the
 * request was NOT processed (auth-rejected before the handler), so retrying a POST
 * can't double-apply. Network failure → a synthetic `offline` result (never throws
 * over IPC). `fetch` is injectable for unit tests.
 */
import type { CloudFetchResult, CloudRoute } from '@mcp/api-bus';

export interface TransportDeps {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  invalidateAccess: () => void;
  appVersion: string;
  os: string;
  /** Real machine identity for the devices list (os.hostname()/os.release()). */
  deviceName?: string;
  osRelease?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createCloudTransport(deps: TransportDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeout = deps.timeoutMs ?? 15_000;

  async function once(route: CloudRoute, input: unknown, token: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'x-cs-client': 'desktop',
      'x-cs-version': deps.appVersion,
      'x-cs-os': deps.os,
    };
    if (deps.deviceName) headers['x-cs-device-name'] = deps.deviceName;
    if (deps.osRelease) headers['x-cs-os-release'] = deps.osRelease;
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method: route.method, headers, signal: AbortSignal.timeout(timeout) };
    if (route.method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(input ?? {});
    }
    return doFetch(`${deps.baseUrl}${route.path((input ?? {}) as Record<string, unknown>)}`, init);
  }

  return {
    async fetch(route: CloudRoute, input: unknown): Promise<CloudFetchResult> {
      try {
        let token = route.auth === 'none' ? null : await deps.getAccessToken();
        if (route.auth === 'required' && !token) return { ok: false, status: 401, body: { code: 'auth_required' } };

        let res = await once(route, input, token);
        if (res.status === 401 && route.auth !== 'none') {
          deps.invalidateAccess();
          token = await deps.getAccessToken(); // single-flight refresh
          if (token) res = await once(route, input, token);
        }
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body };
      } catch (e) {
        return { ok: false, status: 0, body: { code: 'offline', message: String(e) } };
      }
    },
  };
}

export type CloudTransport = ReturnType<typeof createCloudTransport>;
