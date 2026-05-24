/**
 * Rewrite fetch URLs in Electron so the dashboard talks to the backend
 * via the custom `mcp://` protocol instead of a TCP loopback.
 *
 * Why mcp:// instead of http://127.0.0.1:3333:
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
  if (typeof navigator === 'undefined') return false;
  // Electron's chromium fork stamps "Electron/<version>" into the UA.
  // Examples from Electron 33: "...Electron/33.4.0 Safari/537.36".
  return /\bElectron\//i.test(navigator.userAgent);
}

export function installFetchBase(): void {
  if (installed) return;
  installed = true;
  if (!isElectronRenderer()) {
    // Browser dev: relative URLs hit the Vite proxy → Hono dev listener
    // (operator must set MCP_DEV_HTTP=1 for that path to work).
    return;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') {
      if (input.startsWith('/api')) {
        return originalFetch(`${MCP_BASE}${input}`, init);
      }
      // /ws/* deliberately left unchanged — see Fase D in the plan.
    } else if (input instanceof URL) {
      // URL inputs are already absolute. No rewrite needed.
    } else if (input && typeof input === 'object' && 'url' in input) {
      const url = (input as Request).url;
      if (url.startsWith('/api')) {
        return originalFetch(new Request(`${MCP_BASE}${url}`, input as Request), init);
      }
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof window.fetch;

  // Visible-in-DevTools confirmation that the interceptor is wired.
  // Surfaces silently if everything works; helps debug when the next
  // person sees Vite proxy errors and wonders if this ran at all.
  console.info('[mcp] fetch interceptor active — /api/* → mcp://app/api/*');
}
