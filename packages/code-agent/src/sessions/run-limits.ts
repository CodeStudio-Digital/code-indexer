/**
 * Session-owned execution limits.
 *
 * A missing turn limit means the top-level session is unbounded. Automatic
 * continuations only become relevant when a positive turn batch is enabled.
 * The historical process-wide value was 15; new and legacy filesystem
 * sessions materialize that value into their own runtime state.
 */
export const DEFAULT_SESSION_MAX_AUTO_CONTINUES = 15;
export const MAX_SESSION_TURNS = 100_000;
export const MAX_SESSION_AUTO_CONTINUES = 1_000;

export function normalizeSessionMaxTurns(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0
    ? Math.min(MAX_SESSION_TURNS, normalized)
    : null;
}

export function normalizeSessionMaxAutoContinues(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SESSION_MAX_AUTO_CONTINUES;
  }
  return Math.min(
    MAX_SESSION_AUTO_CONTINUES,
    Math.max(0, Math.floor(value)),
  );
}
