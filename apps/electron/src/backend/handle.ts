/**
 * The seam between the Electron main process and the backend.
 *
 * Today there is exactly one implementation (`in-process.ts`) and it does what
 * `main.ts` has always done: `createApp()` in this very process. The point of
 * the interface is that `main.ts` stops naming `deps` / `httpRouter` directly, so
 * a second implementation — the backend living in a `utilityProcess` — can be
 * dropped in without touching the boot sequence.
 *
 * Selected by `MCP_BACKEND_PROCESS`: `0` (default) in-process, `1` utility.
 * Only `0` resolves for now; `1` throws until the utility host lands.
 */

import type { WebContents } from 'electron';
import type { createHandlers } from '@mcp/api-handlers';
import type { ServerDeps } from '@apps/http-api/server/deps.js';

export type ProcessMetricsProvider = NonNullable<ServerDeps['processMetricsProvider']>;
export type ProcessInventoryProvider = NonNullable<ServerDeps['processInventoryProvider']>;

/**
 * Direct object access to a backend sharing this address space.
 *
 * This is the escape hatch, and it is deliberately one named property rather
 * than being spread across the interface: everything reachable through `local`
 * is coupling that has to become a control-bridge RPC before the backend can
 * move out of process. `null` in an out-of-process implementation, so the
 * compiler enumerates the remaining work.
 *
 * As of Onda 2 the users are: terminal IPC (`deps`), the OAuth loopback and the
 * IPC dispatch fallback (`httpRouter`), the preview runner bridge
 * (`handlers.runner` + `deps`), and shutdown.
 */
export interface LocalBackendAccess {
  deps: ServerDeps;
  handlers: ReturnType<typeof createHandlers>;
}

export interface BackendHandle {
  /** Resolves once the backend can serve requests. */
  ready(): Promise<void>;

  /**
   * Dispatch an HTTP-shaped request. Backs the `mcp://` protocol handler and
   * the OAuth loopback listener — the two places that speak Request/Response.
   */
  fetch(req: Request): Promise<Response>;

  /**
   * Make the backend reachable from renderers. In-process this mounts the
   * `ipcMain` channels once, globally; out-of-process it will broker one
   * multiplexed MessagePort per `WebContents` (hence the optional argument,
   * which the in-process implementation ignores).
   */
  attachRenderer(contents?: WebContents): void;

  /** Feed the Electron process tree to the perf sampler. */
  setProcessMetricsProvider(fn: ProcessMetricsProvider): void;

  /** Feed the desktop child registry to the task manager's process inventory. */
  setProcessInventoryProvider(fn: ProcessInventoryProvider): void;

  /** Graceful teardown: pools, MCP, chrome, dev-http. */
  dispose(reason: string): Promise<void>;

  /** Non-null only while the backend shares this process. See above. */
  readonly local: LocalBackendAccess | null;
}

/** Resolve the configured host. Throws for a mode that does not exist yet. */
export function backendProcessMode(): 'in-process' | 'utility' {
  return process.env.MCP_BACKEND_PROCESS === '1' ? 'utility' : 'in-process';
}
