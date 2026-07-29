/**
 * Per-project history of fix prompts sent to the agent (auto-fired,
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
const byProject = new Map<number, AutoFixHistoryEntry[]>();
const listenersByProject = new Map<number, Set<() => void>>();

export function recordAutoFix(projectId: number, entry: AutoFixHistoryEntry): void {
  const list = byProject.get(projectId) ?? [];
  byProject.set(projectId, [...list, entry].slice(-MAX));
  listenersByProject.get(projectId)?.forEach((fn) => fn());
}

export function getAutoFixHistory(projectId: number): AutoFixHistoryEntry[] {
  return byProject.get(projectId) ?? [];
}

export function subscribeAutoFixHistory(projectId: number, fn: () => void): () => void {
  const set = listenersByProject.get(projectId) ?? new Set();
  set.add(fn);
  listenersByProject.set(projectId, set);
  return () => {
    set.delete(fn);
  };
}
