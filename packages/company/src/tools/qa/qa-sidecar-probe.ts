
const HEALTH_PROBE_TIMEOUT_MS = 4_000;

export interface SidecarVersionInfo {
  ok: boolean;
  status?: number;
  /**
   * Browser product string. The Playwright `run-server` health endpoint
   * returns plain text `"Running"` (no version info), so this stays
   * undefined unless we later extend the probe. Kept on the type for
   * back-compat with v3.0 tests.
   */
  browser?: string;
  /** Protocol version. Same caveat as `browser`. */
  protocolVersion?: string;
  /** Last error string when the probe failed. */
  error?: string;
}

/**
 * Pure async helper: probe the Chrome Service's HTTP health endpoint.
 * `playwright run-server` answers any GET with status 200 + body
 * `"Running"` once it's listening; we just check the status, not the
 * body. (Calling `res.json()` would fail on the plain text — that was
 * the v4.0 ECONNREFUSED-looking-but-actually-200 bug.)
 *
 * Used inside the tool handler and standalone in tests via fetch
 * mocks.
 */
export async function fetchSidecarVersion(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Promise<SidecarVersionInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    // Drain the body so the connection can be reused — we don't parse
    // it because the run-server returns plain text, not JSON.
    try { await res.text(); } catch { /* swallow */ }
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
