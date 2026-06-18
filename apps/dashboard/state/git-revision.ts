/**
 * Single funnel for "the project's git state changed" — fed by the git-meta
 * stream (one `useGitMeta` subscription per project in ProjectView) and read by
 * every surface that shows branch-dependent data (status bar, git window,
 * file-tree colors). Each consumer selects `revByProject[projectId]` and
 * refetches when it bumps, so they all re-sync off one signal instead of
 * polling independently.
 */
import { create } from 'zustand';

interface GitRevisionState {
  /** Monotonic counter per project — dependent surfaces refetch when it changes. */
  revByProject: Record<number, number>;
  /** Last branch name seen per project (undefined until the first frame). */
  branchByProject: Record<number, string | null>;
  /**
   * Record a git-meta frame. Returns whether the branch NAME actually changed
   * since the previous frame — the first frame for a project never counts as a
   * switch, so it won't toast.
   *
   * `isSeed` marks the server-pushed snapshot frame (changed:[]) sent on every
   * (re)subscribe: it RECORDS the branch but does NOT bump the revision, so a
   * mount/reconnect doesn't force a redundant refetch on surfaces that already
   * loaded — UNLESS the seed reveals a switch that happened while disconnected,
   * in which case we bump (and the caller toasts) so nothing is missed.
   */
  bump(projectId: number, branch: string | null, isSeed?: boolean): { branchChanged: boolean };
}

export const useGitRevision = create<GitRevisionState>((set, get) => ({
  revByProject: {},
  branchByProject: {},
  bump(projectId, branch, isSeed = false) {
    const prev = get().branchByProject[projectId];
    const branchChanged = prev !== undefined && prev !== branch;
    const bumpRev = !isSeed || branchChanged;
    set((s) => ({
      revByProject: bumpRev
        ? { ...s.revByProject, [projectId]: (s.revByProject[projectId] ?? 0) + 1 }
        : s.revByProject,
      branchByProject: { ...s.branchByProject, [projectId]: branch },
    }));
    return { branchChanged };
  },
}));
