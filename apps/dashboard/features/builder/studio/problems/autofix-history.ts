/**
 * Per-session history of fix prompts sent to the agent (auto-fired,
 * review-accepted, or manual "Fix" clicks). Module-level like the
 * studio-context-store — survives popover unmounts, dies with the page.
 */
export interface AutoFixHistoryEntry {
  ts: number;
  /** Short problem label (same shape the badge list shows). */
  label: string;
  /** How the fix was dispatched. */
  via: 'auto' | 'review' | 'manual';
}

const MAX = 20;
const bySession = new Map<number, AutoFixHistoryEntry[]>();
const listeners = new Map<number, Set<() => void>>();

export function recordAutoFix(sessionId: number, entry: AutoFixHistoryEntry): void {
  const list = bySession.get(sessionId) ?? [];
  bySession.set(sessionId, [...list, entry].slice(-MAX));
  listeners.get(sessionId)?.forEach((fn) => fn());
}

export function getAutoFixHistory(sessionId: number): AutoFixHistoryEntry[] {
  return bySession.get(sessionId) ?? [];
}

export function subscribeAutoFixHistory(sessionId: number, fn: () => void): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(fn);
  listeners.set(sessionId, set);
  return () => {
    set.delete(fn);
  };
}
