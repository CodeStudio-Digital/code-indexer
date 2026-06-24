/**
 * MRU list of recently-opened projects — feeds the title-bar switcher's
 * "Recent" section. Persisted to localStorage (shared across same-partition
 * windows, so it reflects opens from every window) and updated each time a
 * project view mounts. Tiny and dependency-free; mirrors the localStorage
 * conventions in workspace.ts.
 */

const STORAGE_KEY = 'mcp-ide:recent-projects';
const MAX_RECENT = 12;

/** Recent project ids, most-recent first. Empty on SSR / disabled storage. */
export function loadRecentProjects(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  } catch {
    return [];
  }
}

/** Promote `projectId` to the front of the MRU (dedupe, cap, persist). */
export function pushRecentProject(projectId: number): void {
  if (typeof window === 'undefined') return;
  if (typeof projectId !== 'number' || !Number.isFinite(projectId)) return;
  try {
    const next = [projectId, ...loadRecentProjects().filter((id) => id !== projectId)].slice(
      0,
      MAX_RECENT,
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage full / disabled — silently drop */
  }
}
