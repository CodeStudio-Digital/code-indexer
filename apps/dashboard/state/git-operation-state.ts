import { create } from 'zustand';

interface GitOperationState {
  counts: Record<string, number>;
  begin: (key: string) => void;
  end: (key: string) => void;
}

export function gitOperationKey(projectId: number, repoPath?: string): string {
  return `${projectId}:${repoPath ?? '<project>'}`;
}

export const useGitOperationState = create<GitOperationState>((set) => ({
  counts: {},
  begin: (key) => set((state) => ({ counts: { ...state.counts, [key]: (state.counts[key] ?? 0) + 1 } })),
  end: (key) => set((state) => {
    const next = { ...state.counts };
    const count = (next[key] ?? 1) - 1;
    if (count <= 0) delete next[key];
    else next[key] = count;
    return { counts: next };
  }),
}));

export function useGitOperationBusy(projectId: number, repoPath?: string): boolean {
  const key = gitOperationKey(projectId, repoPath);
  return useGitOperationState((state) => (state.counts[key] ?? 0) > 0);
}
