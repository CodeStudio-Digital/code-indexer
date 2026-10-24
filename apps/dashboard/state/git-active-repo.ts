/**
 * Which git root the Git tool window is currently acting on, per project.
 *
 * A project can hold more than one repo (main + submodules + nested repos —
 * see `projectGit.listRepos`). The Git tool window's repo selector writes the
 * SELECTED repo's absolute path here; every git call the window makes threads it
 * as `repoPath` so status / branches / commit / push target that repo. An absent
 * entry means "the project's main repo" (the default), so single-repo projects
 * never store anything.
 *
 * Persisted to localStorage so a reopen restores the last-selected repo. Keyed
 * by projectId (not global) so split / multi-window views stay independent.
 */
import { create } from 'zustand';

const LS_KEY = 'mcp.gitActiveRepo.v1';

function load(): Record<number, string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<number, string>) : {};
  } catch {
    return {};
  }
}

function save(map: Record<number, string>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota — selection just won't persist */
  }
}

interface GitActiveRepoState {
  /** Selected repo absolute path per project; absent = the project's main repo. */
  byProject: Record<number, string>;
  /** Select a repo (pass undefined / the main repo path to clear back to default). */
  setRepo(projectId: number, repoPath: string | undefined): void;
}

export const useGitActiveRepo = create<GitActiveRepoState>((set) => ({
  byProject: load(),
  setRepo(projectId, repoPath) {
    set((s) => {
      const next = { ...s.byProject };
      if (repoPath) next[projectId] = repoPath;
      else delete next[projectId];
      save(next);
      return { byProject: next };
    });
  },
}));

/** Hook: the selected repo absolute path for a project (undefined = main repo). */
export function useActiveRepoPath(projectId: number): string | undefined {
  return useGitActiveRepo((s) => s.byProject[projectId]);
}

/** Non-hook read for imperative callsites (event handlers). */
function getActiveRepoPath(projectId: number): string | undefined {
  return useGitActiveRepo.getState().byProject[projectId];
}
