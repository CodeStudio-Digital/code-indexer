/**
 * Build the packaged renderer policy. Plugin panels are sandboxed `srcDoc`
 * documents and therefore inherit this policy from the dashboard. Their
 * self-contained UI bundles use inline scripts, so the host grants only the
 * per-launch nonce it injects into those scripts.
 */
export function buildRendererCsp(scriptNonce: string): string {
  return [
    "default-src 'self' mcp://app",
    `script-src 'self' 'wasm-unsafe-eval' 'nonce-${scriptNonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: mcp://app",
    "connect-src 'self' mcp://app http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "frame-src 'self' mcp://app http://localhost:* http://127.0.0.1:*",
  ].join('; ');
}
