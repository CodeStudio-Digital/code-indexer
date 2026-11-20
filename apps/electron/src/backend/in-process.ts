/**
 * The backend running inside the Electron main process — what `main.ts` has
 * always done, now behind `BackendHandle`.
 *
 * Behaviour is deliberately unchanged from the inline version: `createApp()`,
 * the optional dev-HTTP listener, `mountIpcHandlers`, the same `timeCall`
 * instrumentation on the Request/Response path, and the same graceful
 * shutdown. The only difference is who holds the references.
 */

import type { WebContents } from 'electron';
import { createApp } from '@apps/http-api/server.js';
import { normalizeRouteKey } from '@apps/http-api/server/handler-tree.js';
import { IN_PROCESS_ENV } from '@apps/http-api/server/middleware/local-origin.js';
import { timeCall } from '@apps/http-api/server/perf/slow-ipc.js';
import { shutdownAppRuntime } from '@apps/http-api/server/runtime-shutdown.js';
import { startOptionalDevHttp, stopDevHttp } from '../dev-http.js';
import { createElectronBrowserHost } from '../browser-context-host.js';
import { mountIpcHandlers } from '../handlers-mount.js';
import type {
  BackendHandle,
  LocalBackendAccess,
  ProcessInventoryProvider,
  ProcessMetricsProvider,
} from './handle.js';

export function createInProcessBackend(): BackendHandle {
  // The HTTP router is built but not served unless MCP_DEV_HTTP=1 — that flag
  // exists so an operator can curl the same backend from outside the window.
  const browser = createElectronBrowserHost();
  const { app: httpRouter, deps, mcpPool, chromeService } = createApp(browser);
  let handlers: LocalBackendAccess['handlers'] | null = null;
  let readyPromise: Promise<void> | null = null;

  const local: LocalBackendAccess = {
    deps,
    // `attachRenderer` builds these; reading before that is a wiring bug.
    get handlers() {
      if (!handlers) throw new Error('[backend] attachRenderer() must run before handlers are read');
      return handlers;
    },
  } as LocalBackendAccess;

  return {
    ready() {
      readyPromise ??= startOptionalDevHttp(httpRouter);
      return readyPromise;
    },

    async fetch(req) {
      // Instrumented here rather than at each call site so the `mcp://`
      // protocol handler and the OAuth loopback are measured identically.
      // For a JSON route `httpRouter.fetch` resolves only after the (synchronous)
      // SQLite handler + serialization complete, so this wall-time ≈ the
      // main-thread block — cross-check loopP99/loopMax in perf-sampler to
      // separate true blocking from awaited async (e.g. git spawns).
      const { method } = req;
      const channel = `mcp:${method} ${normalizeRouteKey(new URL(req.url).pathname)}`;
      // IN_PROCESS_ENV is what lets `requireTrustedLocalRequest` (SSH CRUD)
      // tell this socket-less path apart from a real off-loopback client.
      // It has to ride in `env` — a renderer can forge headers, not this.
      return await timeCall(channel, () => httpRouter.fetch(req, IN_PROCESS_ENV));
    },

    attachRenderer(_contents?: WebContents) {
      // Global and idempotent: `ipcMain` channels are process-wide, so every
      // renderer already reaches them. The per-renderer argument exists for
      // the out-of-process host, which brokers one port per WebContents.
      handlers ??= mountIpcHandlers(deps, httpRouter);
    },

    setProcessMetricsProvider(fn: ProcessMetricsProvider) {
      deps.processMetricsProvider = fn;
    },

    setProcessInventoryProvider(fn: ProcessInventoryProvider) {
      deps.processInventoryProvider = fn;
    },

    async dispose(reason: string) {
      await stopDevHttp();
      try { await shutdownAppRuntime({ deps, mcpPool, chromeService, reason }); }
      finally { await browser.dispose(); }
    },

    local,
  };
}
