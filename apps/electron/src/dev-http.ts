/**
 * Optional HTTP listener inside the Electron main process. Off by
 * default — the renderer talks to the backend via IPC, no port required.
 *
 * Enable with `MCP_DEV_HTTP=1` (or set a port via `MCP_DEV_HTTP_PORT`)
 * when you want to:
 *   - curl the backend from outside the window for debugging
 *   - point an external MCP client at the running instance
 *   - run a second renderer (e.g. open the dashboard in a browser tab
 *     alongside the Electron app)
 *
 * Production builds intentionally leave this disabled so there's no
 * attack surface exposed on loopback.
 */

import { once } from 'node:events';
import type { Server } from 'node:http';
import type { HttpRouter } from '@mcp/shared/http/router.js';

/** The live listener handle, kept so quit can close the socket (it would
 *  otherwise leak a bound port until the process actually exits). */
let handle: Server | null = null;

export async function startOptionalDevHttp(app: HttpRouter): Promise<void> {
  if (process.env.MCP_DEV_HTTP !== '1') return;
  if (handle) return;
  const port = Number(process.env.MCP_DEV_HTTP_PORT ?? process.env.MCP_INDEX_PORT ?? 7333);
  const { listenHttp } = await import('@mcp/shared/http/node-server.js');
  const server = listenHttp({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  handle = server;
  try {
    await once(server, 'listening');
  } catch (error) {
    if (handle === server) handle = null;
    throw error;
  }
  console.log(`[electron] MCP_DEV_HTTP enabled — HTTP listening on http://127.0.0.1:${port}`);
}

/** Close the optional dev-http listener on quit. No-op when it was never started. */
export async function stopDevHttp(): Promise<void> {
  if (!handle) return;
  const current = handle;
  handle = null;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { current.closeAllConnections?.(); } catch { /* already closed */ }
      finish();
    }, 1_000);
    timer.unref?.();
    try { current.close(() => finish()); } catch { finish(); }
  });
}
