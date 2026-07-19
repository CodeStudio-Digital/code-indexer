/**
 * Optional Hono HTTP listener inside the Electron main process. OFF by
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

import type { Hono } from 'hono';

/** The live listener handle, kept so quit can close the socket (it would
 *  otherwise leak a bound port until the process actually exits). */
let handle: {
  close: (cb?: (err?: Error) => void) => void;
  closeAllConnections?: () => void;
} | null = null;

export async function startOptionalDevHttp(app: Hono): Promise<void> {
  if (process.env.MCP_DEV_HTTP !== '1') return;
  if (handle) return;
  const port = Number(process.env.MCP_DEV_HTTP_PORT ?? process.env.MCP_INDEX_PORT ?? 7333);
  const { serve } = await import('@hono/node-server');
  handle = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as NonNullable<typeof handle>;
  console.log(`[electron] MCP_DEV_HTTP enabled — Hono listening on http://127.0.0.1:${port}`);
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
