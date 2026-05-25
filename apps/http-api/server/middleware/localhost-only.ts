/**
 * Localhost-only middleware — rejects any request whose underlying
 * TCP peer isn't loopback. Used in front of the MCP HTTP endpoint so
 * the catalogue of tools is never reachable from the LAN even if the
 * Hono server is bound to 0.0.0.0.
 *
 * Detection uses Node's raw http.IncomingMessage from `@hono/node-server`
 * (`c.env.incoming`). We avoid trusting `X-Forwarded-For` — that header
 * is trivially spoofed and the operator never asked for a reverse-proxy
 * topology.
 *
 * Accepted peer IPs:
 *   - 127.0.0.0/8 (loopback IPv4)
 *   - ::1         (loopback IPv6)
 *   - ::ffff:127.0.0.1 (IPv4-mapped loopback when the kernel uses a
 *                       dual-stack socket)
 *
 * Anything else returns 403 with a hint pointing at the admin section.
 */
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';

function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  if (addr === '::ffff:127.0.0.1') return true;
  // IPv4 loopback: 127.x.y.z (covers the whole /8 reservation).
  if (addr.startsWith('127.')) return true;
  // IPv4-mapped IPv6 of any 127.* — `::ffff:127.0.0.1` already handled
  // above; the more general case stays here for safety.
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}

export function localhostOnlyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // @hono/node-server exposes the raw Node request as c.env.incoming.
    // Anything that bypasses that (workerd, bun, edge) will land here
    // with `undefined`, in which case we refuse rather than guess —
    // the only environment we care about right now is Node+Electron.
    const env = c.env as { incoming?: IncomingMessage } | undefined;
    const peer = env?.incoming?.socket?.remoteAddress;
    if (!isLoopbackAddress(peer)) {
      return c.json(
        {
          error: 'localhost_only',
          message:
            'The MCP HTTP endpoint only accepts connections from 127.0.0.1. ' +
            'Run the client on the same machine, or enable LAN access from the admin panel (Settings → MCP HTTP).',
          peer: peer ?? null,
        },
        403,
      );
    }
    await next();
  };
}
