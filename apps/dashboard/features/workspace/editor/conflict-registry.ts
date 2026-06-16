/**
 * Tiny subscribable registry of which working-tree files are currently
 * conflicted, for the active project. The Git tool window writes it when
 * `projectGit.mergeState` arrives; the editor reads it (via
 * `useIsConflicted`) to decide whether to light up conflict UI on an open
 * file — without threading props through EditorPane.
 *
 * Keyed by projectId so a stale set never bleeds into another project's
 * files. Cleared when no sequencer op is in progress.
 */

import { useSyncExternalStore } from 'react';

let state: { projectId: number | null; paths: Set<string> } = { projectId: null, paths: new Set() };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setConflicts(projectId: number, paths: string[]): void {
  state = { projectId, paths: new Set(paths) };
  emit();
}

export function clearConflicts(): void {
  if (state.projectId === null && state.paths.size === 0) return;
  state = { projectId: null, paths: new Set() };
  emit();
}

export function isConflicted(projectId: number, path: string): boolean {
  return state.projectId === projectId && state.paths.has(path);
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
