/**
 * Host side of the plugin webview bridge. Sandboxed plugin iframes (null
 * origin) postMessage `{ __mcpPlugin:'invoke', id, method, payload }`; we
 * forward ONLY whitelisted read-only api-bus methods to `apiCall` and post
 * the result back. Anything off-list is rejected, so a webview can read
 * project context but never mutate or reach privileged surfaces.
 */
import { apiCall } from '../../lib/api-client.js';

/** Read-only methods a plugin webview may call. Conservative by design. */
const ALLOWED = new Set<string>([
  'plugins.list',
  'plugins.get',
  'projects.list',
  'projects.get',
  'files.read',
]);

interface InvokeMessage {
  __mcpPlugin: 'invoke';
  id: number;
  method: string;
  payload?: unknown;
}

function isInvoke(d: unknown): d is InvokeMessage {
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as { __mcpPlugin?: unknown }).__mcpPlugin === 'invoke' &&
    typeof (d as { method?: unknown }).method === 'string'
  );
}

/** Install the global listener. Returns a disposer. Safe to call once on mount. */
export function installWebviewBridge(): () => void {
  const onMessage = async (e: MessageEvent): Promise<void> => {
    if (!isInvoke(e.data)) return;
    const { id, method, payload } = e.data;
    const source = e.source as WindowProxy | null;
    if (!source) return;
    if (!ALLOWED.has(method)) {
      source.postMessage({ __mcpPlugin: 'result', id, ok: false, error: `method not allowed: ${method}` }, '*');
      return;
    }
    try {
      const result = await apiCall(method, payload);
      source.postMessage({ __mcpPlugin: 'result', id, ok: true, result }, '*');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      source.postMessage({ __mcpPlugin: 'result', id, ok: false, error }, '*');
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
