import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { getQaEndpointEnvStore } from './qa-endpoint-state.js';

export const PREFLIGHT_ACTION =
  'Configure a Playwright WebSocket endpoint in PLAYWRIGHT_WS_ENDPOINT, or use the desktop Preview for interactive checks.';

type PreflightResult = { ok: true; wsEndpoint: string } | { ok: false; message: string };

export async function preflightBrowser(deps: {
  sessionId: string;
  envStore?: CompanySessionEnvStore | null;
}): Promise<PreflightResult> {
  const store = deps.envStore !== undefined ? deps.envStore : getQaEndpointEnvStore();
  // Older installations auto-filled this setting with the retired service.
  const row = (await store?.listAsync(deps.sessionId))?.find(item =>
    item.key === 'PLAYWRIGHT_WS_ENDPOINT' && item.source !== 'auto');
  const wsEndpoint = row?.value.trim();
  if (wsEndpoint) {
    try {
      const { protocol } = new URL(wsEndpoint);
      if (protocol === 'ws:' || protocol === 'wss:') return { ok: true, wsEndpoint };
    } catch { /* Invalid URL. */ }
  }
  return { ok: false, message: PREFLIGHT_ACTION };
}
