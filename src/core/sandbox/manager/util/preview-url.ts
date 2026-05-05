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
 * Default preview URL: relative to the API origin; the preview proxy
 * rewrites `/preview/:id/*` onto `http://127.0.0.1:<hostPort>/`.
 * Subdomain strategies override this via `SandboxManagerOptions.buildPreviewUrl`.
 */
export function defaultPreviewUrl(sessionId: string, _hostPort: number): string {
  return `/preview/${encodeURIComponent(sessionId)}/`;
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
