/**
 * Strips the "Bearer " prefix from an `Authorization` header value.
 * Returns empty string for missing/malformed input — the validator then
 * raises the domain-level `missing_bearer` error.
 */
export function parseBearerHeader(header: string | null | undefined): string {
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/**
 * Extract headers safe to expose to tool handlers. Drops `authorization`
 * and `cookie` so raw credentials never leak into tool logic.
 */
export function safeRequestHeaders(headers: Headers): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    const key = k.toLowerCase();
    if (key === 'authorization' || key === 'cookie') continue;
    out[key] = v;
  }
  return out;
}
