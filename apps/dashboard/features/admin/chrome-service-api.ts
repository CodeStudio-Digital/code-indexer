/**
 * Frontend API client for the Chrome Service singleton.
 *
 * Endpoints (`/api/admin/chrome-service*`):
 *   GET    → snapshot (config + live healthcheck)
 *   PATCH  → update enabled / image / host_port
 *   POST /restart → disable + enable
 *   POST /test    → on-demand healthcheck
 *
 * Mirrors `mcp-servers-api.ts` shape so `ChromeServicePanel` can stay
 * tiny (~150L). All errors propagate as `Error` with the response
 * body — caller catches and surfaces in the UI.
 */

export type ChromeServiceStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ChromeServiceState {
  enabled: boolean;
  status: ChromeServiceStatus;
  image: string;
  hostPort: number;
  containerId: string | null;
  wsEndpoint: string;
  loopbackHealthUrl: string;
  lastError: string | null;
  startedAt: string | null;
  alive?: boolean;
  browser?: string;
  protocolVersion?: string;
}

interface ChromeServicePatch {
  enabled?: boolean;
  image?: string;
  host_port?: number;
}

const BASE = '/api/admin/chrome-service';

export async function fetchChromeService(): Promise<ChromeServiceState> {
  return getJson<ChromeServiceState>(BASE);
}

export async function patchChromeService(patch: ChromeServicePatch): Promise<ChromeServiceState> {
  const res = await fetch(BASE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await safeText(res));
  return res.json() as Promise<ChromeServiceState>;
}

export async function restartChromeService(): Promise<ChromeServiceState> {
  const res = await fetch(`${BASE}/restart`, { method: 'POST' });
  if (!res.ok) throw new Error(await safeText(res));
  return res.json() as Promise<ChromeServiceState>;
}

export async function testChromeService(): Promise<ChromeServiceState> {
  const res = await fetch(`${BASE}/test`, { method: 'POST' });
  if (!res.ok) throw new Error(await safeText(res));
  return res.json() as Promise<ChromeServiceState>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await safeText(res));
  return res.json() as Promise<T>;
}

async function safeText(res: Response): Promise<string> {
  try {
    return `${res.status} ${res.statusText} — ${await res.text()}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}
