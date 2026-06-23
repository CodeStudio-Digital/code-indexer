/**
 * Shared "since" time-window presets for telemetry panels. Used by both the
 * global Telemetry overview and the pipeline-telemetry panel so the period
 * filter behaves identically across tabs.
 */

export const SINCE_PRESETS: Array<{ key: string; days: number | null }> = [
  { key: 'all', days: null },
  { key: '24h', days: 1 },
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
];

/** Resolve a preset key to a SQLite `datetime('now')`-compatible cutoff, or null for "all". */
export function sinceForKey(key: string): string | null {
  const preset = SINCE_PRESETS.find((p) => p.key === key);
  if (!preset || preset.days == null) return null;
  const d = new Date(Date.now() - preset.days * 24 * 3600 * 1000);
  // Match SQLite's datetime('now') format: 'YYYY-MM-DD HH:MM:SS' UTC.
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
