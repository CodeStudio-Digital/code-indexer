/**
 * Pure helpers used by the CLI/OCI driver — container name sanitisation
 * and `docker stats` output parsers. Extracted from `cli-oci-driver.ts`
 * so the regex / unit-conversion logic can be unit-tested without
 * spinning a fake shell.
 */

/**
 * Normalize a sessionId into a container name that docker/podman accept
 * AND that the dashboard displays cleanly. Allows alnum + underscore +
 * dot + dash; everything else collapses to `-`. Truncated to 48 chars
 * because OCI runtimes have shorter practical limits than POSIX.
 */
export function sanitizeContainerName(sessionId: string): string {
  const clean = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
  return `mcp-sbx-${clean}`;
}

/**
 * Parse strings like "12.3%" → 12.3. Returns null when the input is
 * absent or unparseable. Used to read CPU% from `docker stats`.
 */
export function parsePercent(raw: string | undefined): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse docker-stats memory strings. Accepts:
 *   - `"245.8MiB / 1GiB"` (take the first token, IEC binary suffix)
 *   - `"245.8MB / 1GB"`   (SI decimal)
 *   - `"245800000"`        (raw bytes)
 *   - objects the caller pre-reduced to a string elsewhere
 */
export function parseMemBytes(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  const used = s.split('/')[0]?.trim() ?? s;
  const m = used.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?i?B)?$/i);
  if (!m) {
    const n = Number(used);
    return Number.isFinite(n) ? n : null;
  }
  const value = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1_000,
    KIB: 1_024,
    MB: 1_000_000,
    MIB: 1_024 ** 2,
    GB: 1_000_000_000,
    GIB: 1_024 ** 3,
    TB: 1_000_000_000_000,
    TIB: 1_024 ** 4,
    PB: 1_000_000_000_000_000,
    PIB: 1_024 ** 5,
  };
  const mult = multipliers[unit] ?? 1;
  return value * mult;
}
