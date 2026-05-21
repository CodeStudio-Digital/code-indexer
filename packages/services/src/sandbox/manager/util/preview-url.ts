/**
 * Resolve the operator-configured public base URL used to absolutize
 * preview URLs in managed envs. Precedence: `MCP_PUBLIC_URL` →
 * `MCP_DASHBOARD_URL` → null.
 */
export function resolvePublicBase(): string | null {
  const raw = process.env.MCP_PUBLIC_URL ?? process.env.MCP_DASHBOARD_URL ?? '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed || null;
}

/**
 * Default preview URL: direct loopback URL to the dev-server inside the
 * container. The previous proxy at `/preview/:id/*` was removed in
 * Phase C of the "living company" restructure — single-user dev doesn't
 * need the auth/path-rewriting middle layer. Subdomain strategies
 * override this via `SandboxManagerOptions.buildPreviewUrl`.
 */
export function defaultPreviewUrl(_sessionId: string, hostPort: number): string {
  return `http://127.0.0.1:${hostPort}/`;
}

/**
 * When `previewUrl` is absolute, strip origin to get the path prefix
 * Vite's `base` config needs.
 */
export function previewPathPrefixOf(previewUrl: string): string {
  try {
    const u = new URL(previewUrl, 'http://placeholder.invalid');
    return u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  } catch {
    return previewUrl.endsWith('/') ? previewUrl : `${previewUrl}/`;
  }
}
