/**
 * Tiny subscribable registry of which working-tree files are currently
 * conflicted, for the active project. The Git tool window writes it when
 * `projectGit.mergeState` arrives; the editor reads it (via
 * `useIsConflicted`) to decide whether to light up conflict UI on an open
 * file — without threading props through EditorPane.
 *
 * Paths are stored PROJECT-relative (the editor opens files project-relative),
 * grouped by the repo — its `projectRelPrefix`, '' for the main repo — that
 * reported them. mergeState returns repoRoot-relative paths, so a submodule's
 * conflicts come back submodule-relative; the caller rebases them to project-
 * relative before writing here. Grouping by repo makes the lit-up set a UNION,
 * so a submodule mid-merge AND the main repo mid-merge can both highlight, and
 * switching the Git window's active repo only updates that repo's slice.
 *
 * Keyed by projectId too so a stale set never bleeds into another project.
 */

import { useSyncExternalStore } from 'react';

let state: { projectId: number | null; byRepo: Map<string, Set<string>> } = {
  projectId: null,
  byRepo: new Map(),
};
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Set the conflicted PROJECT-relative paths for ONE repo, identified by its
 * `repoPrefix` (projectRelPrefix; '' = main). Replaces only that repo's slice,
 * leaving other repos' conflicts intact.
 */
export function setConflicts(projectId: number, repoPrefix: string, paths: string[]): void {
  const byRepo = state.projectId === projectId ? new Map(state.byRepo) : new Map<string, Set<string>>();
  byRepo.set(repoPrefix, new Set(paths));
  state = { projectId, byRepo };
  emit();
}

/**
 * Clear conflicts. With `repoPrefix` → only that repo's slice (when projectId
 * owns the set). With only `projectId` → that project's whole set. Omit both →
 * force-clear (unmount / project switch).
 */
export function clearConflicts(projectId?: number, repoPrefix?: string): void {
  if (projectId !== undefined && state.projectId !== projectId) return;
  if (repoPrefix !== undefined) {
    if (!state.byRepo.has(repoPrefix)) return;
    const byRepo = new Map(state.byRepo);
    byRepo.delete(repoPrefix);
    state = { projectId: state.projectId, byRepo };
    emit();
    return;
  }
  if (state.projectId === null && state.byRepo.size === 0) return;
  state = { projectId: null, byRepo: new Map() };
  emit();
}

export function isConflicted(projectId: number, path: string): boolean {
  if (state.projectId !== projectId) return false;
  for (const set of state.byRepo.values()) if (set.has(path)) return true;
  return false;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ── "git changed, please refresh" channel ──────────────────────────
// The 3-pane merge editor lives in the editor pane, decoupled from the
// Git tool window that owns mergeState. After it resolves a file it pings
// this channel so the Git window re-fetches status + mergeState.
const reloadListeners = new Set<() => void>();
export function onGitReloadRequest(cb: () => void): () => void {
  reloadListeners.add(cb);
  return () => { reloadListeners.delete(cb); };
}
export function requestGitReload(): void {
  for (const l of reloadListeners) l();
}

/** React binding — re-renders the caller when `path`'s conflict status flips. */
export function useIsConflicted(projectId: number, path: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isConflicted(projectId, path),
  );
}
