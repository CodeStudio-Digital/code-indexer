import type { SessionState } from './types.js';

/**
 * Upper bound on how many per-session state slots `useAgentStream` keeps
 * resident. Each slot retains the live turn plus per-turn metrics, so without
 * a cap the map grows per session the user opens over a long work session
 * (the hook is mounted once and `sessionId` just changes). We never evict the
 * active session or one with a background run still streaming — only idle,
 * previously-viewed sessions beyond this cap. (The worker event log lives in
 * its own `worker-log-store`, which self-bounds to the same `MAX_SESSIONS`.)
 */
export const MAX_SESSIONS = 8;

/**
 * Drop the least-recently-touched idle sessions once the map exceeds
 * `MAX_SESSIONS`. Protected from eviction: the currently-viewed session and
 * any session whose run is still `streaming` (background runs are intentional
 * and must survive tab switches). Pure given its inputs; also trims the
 * recency map for removed ids.
 */
export function pruneSessions(
  map: Record<number, SessionState>,
  activeSid: number | null,
  touched: Map<number, number>,
): Record<number, SessionState> {
  const ids = Object.keys(map).map(Number);
  if (ids.length <= MAX_SESSIONS) return map;
  const evictable = ids
    .filter((id) => id !== activeSid && !map[id]?.streaming)
    .sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
  const toRemove = Math.min(ids.length - MAX_SESSIONS, evictable.length);
  if (toRemove <= 0) return map;
  const removeSet = new Set(evictable.slice(0, toRemove));
  const next: Record<number, SessionState> = {};
  for (const id of ids) {
    if (removeSet.has(id)) touched.delete(id);
    else next[id] = map[id];
  }
  return next;
}
