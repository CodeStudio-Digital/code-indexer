import type { Context, Next } from 'hono';
import type { IncomingMessage } from 'node:http';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLoopback(address: string | undefined): boolean {
  return !!address && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));
}

function isLocalOrigin(origin: string | undefined): boolean {
  // Non-browser clients omit Origin. The literal `null` is sent by sandboxed
  // browser contexts and must not bypass the browser-origin check.
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Protect local, state-changing IDE surfaces even when global CORS is broad.
 * Requests without a raw Node socket are refused: production is Node/Electron,
 * so an absent peer is not a topology we need to guess about. */
export async function requireLocalRequest(c: Context, next: Next): Promise<Response | void> {
  if (!isLocalOrigin(c.req.header('origin'))) {
    return c.json({ error: 'local_origin_required', message: 'This IDE operation only accepts local origins.' }, 403);
  }
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (!incoming || !isLoopback(incoming.socket.remoteAddress)) {
    return c.json({ error: 'localhost_only', message: 'This IDE operation only accepts loopback clients.' }, 403);
  }
  await next();
}

/**
 * Hono `env` handed to `app.fetch` by every in-process dispatcher (the
 * `mcp://` protocol handler and the IPC fallback in hono-dispatch.ts).
 * Exported so the marker can't drift between producer and consumer.
 */
export const IN_PROCESS_ENV = { inProcess: true } as const;

/**
 * Same protection as `requireLocalRequest`, but ALSO admits the in-process
 * dispatch path used by the packaged Electron app.
 *
 * The renderer reaches these routes over `mcp://app/...`, which the main
 * process intercepts and hands to `honoApp.fetch(req, { inProcess: true })` —
 * there is no socket at all, so the loopback-peer check above can never pass
 * and `requireLocalRequest` would 403 the whole surface in production.
 *
 * The marker MUST travel in Hono's `env` (the 2nd arg of `app.fetch`), never in
 * a header: a compromised renderer can forge any header it likes, but it cannot
 * reach into the main process to construct `env`.
 */
export async function requireTrustedLocalRequest(c: Context, next: Next): Promise<Response | void> {
  if ((c.env as { inProcess?: boolean } | undefined)?.inProcess === true) {
    await next();
    return;
  }
  return requireLocalRequest(c, next);
}
