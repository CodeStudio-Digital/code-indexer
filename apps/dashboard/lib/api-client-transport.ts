import { fromSerializableAsyncIterator, type SerializableAsyncIterator } from '@mcp/shared/utils/serializable-stream.js';

export type DotPath = string;

export interface ApiCallOptions { signal?: AbortSignal }

let cancellableInvokeSeq = 0;

/**
 * Base URL for HTTP fetches against the backend.
 *
 * Inside Electron: prefix with `mcp://app` so the request rides the
 * custom protocol handler we registered in the main process — same
 * HTTP routes, but dispatched in-process via `app.fetch(Request)`,
 * NO socket, NO loopback. The HTTP listener for development stays off by
 * default (MCP_DEV_HTTP=0).
 *
 * In browser dev (vite dev): empty base so relative URLs route through
 * the Vite proxy to the standalone HTTP listener.
 *
 * Detection: `navigator.userAgent` contains "Electron" in the desktop
 * shell. We DON'T rely on `window.electronAPI` here — the preload that
 * exposes that field can fail or load late, and we still want the URL
 * to point at the mcp:// scheme (which the main process registers
 * unconditionally). Mirrors install-fetch-base's logic.
 *
 * Override at runtime via `window.__MCP_API_BASE__` for tunnels /
 * remote backends.
 */
export function apiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const override = (window as unknown as { __MCP_API_BASE__?: string }).__MCP_API_BASE__;
  if (typeof override === 'string') return override;
  if (isElectronRenderer()) return 'mcp://app';
  return '';
}

/**
 * Detect the Electron desktop shell.
 *
 * The UA check is the primary signal, BUT after the Electron 42 upgrade some
 * renderers no longer carry "Electron/" in `navigator.userAgent` — so the
 * UA-only check returned false INSIDE the app, `apiBaseUrl()` fell back to ''
 * (relative), and `/api/*` hit the http loopback / Vite proxy (7317→7333)
 * instead of the in-process `mcp://app` backend where company orchestrators
 * live → `/answer` 404'd with "No active orchestrator".
 *
 * The reliable fallback is the preload-exposed `electronAPI.invoke` primitive:
 * a plain function that crosses `contextBridge` (Proxies don't — see
 * `electronInvoke`) and is present in EVERY app window. A browser never has it,
 * so there are no false positives. Shared by the fetch interceptor
 * (install-fetch-base.ts) so the two transports never disagree.
 */
function isElectronRenderer(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent)) return true;
  const electron = (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI;
  return !!electron && typeof electron.invoke === 'function';
}

/**
 * Detect Electron via the contextBridge primitive. Previously we walked
 * `window.electronAPI.api.foo.bar` to resolve a method — that relied on
 * a Proxy surviving contextBridge, which it does NOT (Electron serialises
 * exposed objects and Proxies have no own enumerable properties to walk).
 * Effect: every IPC call silently fell through to `dottedToHttp`, and any
 * method without an HTTP mapping (e.g. `terminal.spawn`) threw.
 *
 * Now we just check whether the primitive `invoke` is present — that's
 * exposed as a plain function in preload, which DOES cross the bridge.
 */
export function electronInvoke(): ((methodPath: string, payload: unknown, requestId?: string) => Promise<unknown>) | null {
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!electron || typeof electron.invoke !== 'function') return null;
  return electron.invoke.bind(electron);
}

export function electronCancelInvoke(): ((requestId: string) => void) | null {
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  return electron?.cancelInvoke?.bind(electron) ?? null;
}

export function abortError(): Error {
  const error = new Error('request cancelled');
  error.name = 'AbortError';
  return error;
}

export function nextInvokeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `renderer-${Date.now()}-${++cancellableInvokeSeq}`;
}

export function electronOpenStream(): (<T>(methodPath: string, payload: unknown) => AsyncIterable<T>) | null {
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!electron || typeof electron.openStream !== 'function') return null;
  return <T>(methodPath: string, payload: unknown): AsyncIterable<T> => {
    const iterator = electron.openStream<T>(methodPath, payload) as SerializableAsyncIterator<T>;
    return fromSerializableAsyncIterator(iterator);
  };
}
