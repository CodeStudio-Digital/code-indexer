/**
 * Loads the git roots inside a project (main + submodules + nested repos) for
 * the Git tool window's repo selector. Discovery starts only after the tool is
 * opened and is not repeated for ordinary ref/index changes.
 */
import { useEffect, useState } from 'react';
import type { GitRepoRef } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';

export function useProjectRepos(projectId: number, active = true): { repos: GitRepoRef[]; loading: boolean } {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    apiCall<GitRepoRef[]>('projectGit.listRepos', { projectId })
      .then((r) => { if (alive) setRepos(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive) setRepos([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, projectId]);

  return { repos, loading };
}
