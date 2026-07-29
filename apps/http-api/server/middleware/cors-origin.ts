/**
 * Which browser origins may talk to the local IDE API.
 *
 * WHY: this server was mounted with `cors({ origin: '*' })` as its ONLY global
 * middleware. `*` on a localhost API is not the harmless default it looks like:
 * any page the user happens to have open — an ad frame, a random tab — could
 * script `fetch('http://127.0.0.1:7333/api/…')` and read the response, which
 * includes the project list, file contents, and the SSH host and secret tables.
 * Loopback is not a security boundary against the user's own browser.
 *
 * The policy is a reflector rather than a fixed list because the legitimate
 * callers use ephemeral ports (Vite dev servers, preview windows) that can't be
 * enumerated ahead of time. What it will NOT reflect is any remote origin.
 *
 * Requests with no `Origin` header (curl, the MCP clients, server-to-server)
 * are unaffected: CORS only governs browsers, and a browser always sends one.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The Electron renderer's privileged scheme — no socket, no port, no authority. */
const APP_SCHEME_ORIGINS = new Set(['mcp://app']);

/**
 * Build the `origin` callback for hono's `cors()`.
 *
 * @param allowlist Extra exact-match origins from config (`mcp.http.corsOrigins`),
 *   for an operator who deliberately fronts the API with something else.
 */
export function buildCorsOrigin(allowlist: readonly string[] = []): (origin: string) => string | null {
  const allowed = new Set(allowlist.map((o) => o.trim()).filter(Boolean));
  return (origin: string): string | null => {
    if (!origin) return null; // non-browser caller — nothing to reflect
    if (APP_SCHEME_ORIGINS.has(origin) || allowed.has(origin)) return origin;
    return isLoopbackOrigin(origin) ? origin : null;
  };
}

/** True for http(s) on a loopback host, any port. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the literal `null` a sandboxed frame sends
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // `url.hostname` strips the brackets IPv6 literals carry in an origin string.
  return LOOPBACK_HOSTS.has(url.hostname);
}
