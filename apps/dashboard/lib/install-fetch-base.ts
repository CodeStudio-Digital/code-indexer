/**
 * Install a fetch interceptor that rewrites `/api/*` and `/ws/*` paths
 * to an absolute base URL when the dashboard runs inside Electron.
 *
 * Rationale: Vite's dev proxy was eating SSE flushes from the coder
 * stream (the chat hung at "iniciando…"). Going direct to the Hono
 * listener on 127.0.0.1:3333 (the in-process backend's MCP_DEV_HTTP
 * port) bypasses the proxy entirely and reliably delivers chunks.
 *
 * The interceptor is conditional on `window.electronAPI` so the
 * browser dev experience stays unchanged — relative URLs keep hitting
 * the Vite proxy.
 *
 * Override the base via `window.__MCP_API_BASE__` for tunnels / remote
 * backends. Install once at app startup before any component fetches.
 */

import { apiBaseUrl } from './api-client.js';

let installed = false;

export function installFetchBase(): void {
  if (installed) return;
  installed = true;
  const base = apiBaseUrl();
  if (!base) return; // Browser dev: keep the relative-URL Vite-proxy path.

  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // Only rewrite string inputs that start with `/api` or `/ws`. URL /
    // Request inputs already carry an absolute origin (or were built by
    // code that knows what it's doing).
    if (typeof input === 'string') {
      if (input.startsWith('/api') || input.startsWith('/ws')) {
        return originalFetch(`${base}${input}`, init);
      }
    } else if (input instanceof URL) {
      // URLs are already absolute — no rewrite.
    } else if (input && typeof input === 'object' && 'url' in input) {
      // Request instance — only inspect; reconstruct if needed.
      const url = (input as Request).url;
      if (url.startsWith('/api') || url.startsWith('/ws')) {
        const rewritten = `${base}${url}`;
        return originalFetch(new Request(rewritten, input as Request), init);
      }
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
}
