/**
 * Rewrite fetch URLs in Electron so the dashboard talks to the backend
 * via the custom `mcp://` protocol instead of a TCP loopback.
 *
 * Why mcp:// instead of http://127.0.0.1:7333:
 *   - Zero socket / zero port — Electron's `protocol.handle('mcp', …)`
 *     intercepts the request in the main process and dispatches it
 *     directly to `honoApp.fetch(Request)` in-process.
 *   - Streaming responses (SSE for the coder chat, indexer progress)
 *     work because we registered the scheme with `stream: true`, so
 *     `response.body` arrives as a ReadableStream the existing
 *     ReconnectingSSEClient consumes unchanged.
 *   - No CORS, no MITM proxies, no "is the listener up?" race.
 *
 * Detection: we use `navigator.userAgent` (which always contains
 * "Electron" inside the desktop shell) rather than `window.electronAPI`.
 * Why: the preload script that exposes `electronAPI` can fail or load
 * late, and we still want fetch interception to work — the `mcp://`
 * protocol handler is registered by the main process, independent of
 * the preload. If electronAPI is missing the renderer just loses
 * native dialogs / terminal IPC, but the API surface still works.
 *
 * Install once at app startup, before any component fetches.
 *
 * /ws/* (WebSocket) is NOT yet rewritten — WebSocket can't ride on a
 * custom scheme. Terminal + runs WebSocket migration to MessagePort
 * streaming lands in Fase D of the kill-HTTP sprint.
 */

let installed = false;

const MCP_BASE = 'mcp://app';

function isElectronRenderer(): boolean {
  if (typeof window === 'undefined') return false;
  // Electron's chromium fork stamps "Electron/<version>" into the UA.
  // Examples from Electron 33: "...Electron/33.4.0 Safari/537.36".
  if (typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent)) return true;
  // After the Electron 42 upgrade some renderers no longer carry "Electron/"
  // in the UA, so the UA-only check returned false INSIDE the app and every
  // relative `/api/*` leaked to the http loopback (Vite proxy 7317→7333)
  // instead of mcp://app — company orchestrators (in-process) became
  // unreachable and /answer 404'd. The preload-exposed `electronAPI.invoke`
  // primitive crosses contextBridge reliably and exists in every app window
  // (a browser never has it), so use it as the fallback. Mirrors
  // `isElectronRenderer` in lib/api-client.ts — keep the two in sync.
  const electron = (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI;
  return !!electron && typeof electron.invoke === 'function';
}

export function installFetchBase(): void {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // Decide PER-CALL, not once at startup: `isElectronRenderer()` leans on the
    // preload-exposed `electronAPI.invoke`, which is guaranteed present by the
    // time any component fetches — even if it raced this startup install. In a
    // plain browser this stays false and every call passes through to the Vite
    // proxy unchanged (relative URLs → 7317 → backend).
    if (isElectronRenderer()) {
      if (typeof input === 'string') {
        if (input.startsWith('/api')) {
          return originalFetch(`${MCP_BASE}${input}`, init);
        }
        // /ws/* deliberately left unchanged — see Fase D in the plan.
      } else if (input && typeof input === 'object' && !(input instanceof URL) && 'url' in input) {
        // URL inputs are already absolute; only relative Request urls need it.
        const url = (input as Request).url;
        if (url.startsWith('/api')) {
          return originalFetch(new Request(`${MCP_BASE}${url}`, input as Request), init);
        }
      }
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof window.fetch;

  // Visible-in-DevTools confirmation that the interceptor is wired. The actual
  // rewrite is gated per-call on isElectronRenderer().
  console.info('[mcp] fetch interceptor installed — /api/* → mcp://app in Electron');
}
