/**
 * One-shot "open this file AT this position" handoff between panes that
 * open files (selection chip, problems, search) and the Monaco mount.
 *
 * The opener stores the target position keyed by project-relative path;
 * MonacoMount consumes it once the model for that path is active. Module
 * level on purpose (same pattern as studio-context-store) — survives the
 * tab-switch unmount/remount dance without threading props through the
 * workspace layout.
 */
export interface PendingReveal {
  line: number;
  column: number;
}

const byPath = new Map<string, PendingReveal>();

export function setPendingReveal(path: string, reveal: PendingReveal): void {
  byPath.set(path, reveal);
}

/** Returns and clears the pending position for `path` (one-shot). */
export function consumePendingReveal(path: string): PendingReveal | null {
  const hit = byPath.get(path) ?? null;
  if (hit) byPath.delete(path);
  return hit;
}
