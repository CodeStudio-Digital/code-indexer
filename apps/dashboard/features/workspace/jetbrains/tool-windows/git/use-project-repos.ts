/** Lists immediately usable roots while bounded discovery continues in the background. */
import { useEffect, useState } from 'react';
import type { GitRepoRef } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';
import { useGitActiveRepo } from '../../../../../state/git-active-repo.js';

export function useProjectRepos(projectId: number, active = true): { repos: GitRepoRef[]; loading: boolean } {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRepos([]);
    setLoading(true);
    const load = async (): Promise<void> => {
      try {
        const result = await apiCall<GitRepoRef[]>('projectGit.listRepos', { projectId });
        if (!alive) return;
        const rows = Array.isArray(result) ? result : [];
        const pending = rows.some((repo) => repo.discoveryPending);
        if (pending) timer = setTimeout(() => { void load(); }, 1000);
        // Restore a saved nested selection only when its root is known. A
        // partial list must not temporarily redirect the user's actions to main.
        const selected = useGitActiveRepo.getState().byProject[projectId];
        if (pending && selected && !rows.some((repo) => repo.absPath === selected)) return;
        setRepos(rows);
        setLoading(false);
      } catch { if (alive) { setRepos([]); setLoading(false); } }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [active, projectId]);
  return { repos, loading };
}
