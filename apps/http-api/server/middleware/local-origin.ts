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
