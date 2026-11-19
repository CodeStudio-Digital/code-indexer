import { useEffect, useMemo, useState } from 'react';
import { apiPost } from '../../hooks/useApi.js';

interface LinkedCheckout {
  projectId: number;
  worktreePath: string;
}

export function useProjectCheckout(projectId: number, path: string | null) {
  const request = useMemo(() => ({ projectId, path }), [projectId, path]);
  const [resolved, setResolved] = useState<{ request: typeof request; checkout?: LinkedCheckout; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void apiPost<LinkedCheckout>('/coder/worktrees/workspace', { project_id: projectId, worktree_path: path }, controller.signal, { invalidateReads: false })
      .then(checkout => {
        if (!controller.signal.aborted) setResolved({ request, checkout });
      })
      .catch(error => {
        if (!controller.signal.aborted) setResolved({ request, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [request, path, projectId]);
  const current = resolved?.request === request ? resolved : null;
  return {
    workspaceId: path == null ? projectId : current?.checkout?.projectId ?? null,
    workspaceRoot: current?.checkout?.worktreePath ?? null,
    workspaceError: path ? current?.error : undefined,
  };
}
