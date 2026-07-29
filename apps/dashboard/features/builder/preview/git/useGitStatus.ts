import { useCallback, useEffect, useState } from 'react';
import { workspaceApi, type GitStatusResponse } from '../api.js';

export function useGitStatus(sessionId: string, projectId: number | null) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (projectId == null) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await workspaceApi.gitStatus(sessionId, projectId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { status, loading, error, refresh, setStatus };
}
