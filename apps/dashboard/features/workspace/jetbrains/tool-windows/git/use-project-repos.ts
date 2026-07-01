/**
 * Loads the git roots inside a project (main + submodules + nested repos) for
 * the Git tool window's repo selector. Re-fetches when the project's git
 * revision bumps (a checkout / commit / fetch can add or initialize a
 * submodule). Returns just the main repo for an ordinary single-repo project.
 */
import { useEffect, useState } from 'react';
import type { GitRepoRef } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';
import { useGitRevision } from '../../../../../state/git-revision.js';

export function useProjectRepos(projectId: number): { repos: GitRepoRef[]; loading: boolean } {
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiCall<GitRepoRef[]>('projectGit.listRepos', { projectId })
      .then((r) => { if (alive) setRepos(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive) setRepos([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, gitRev]);

  return { repos, loading };
}
