import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApi } from '../../hooks/useApi.js';
import { usePolling } from '../../hooks/usePolling.js';
import { getAgentSessionActivitySnapshot, subscribeActiveAgentSessions } from '../../hooks/agent-stream/session-stream-store.js';
import { executingSessionIds, type RuntimeActivity } from './session-activity.js';
import type { CoderSession } from './types.js';

export function useSessionActivity(sessions: CoderSession[] | null): Set<string> {
  const live = useSyncExternalStore(subscribeActiveAgentSessions, getAgentSessionActivitySnapshot, getAgentSessionActivitySnapshot);
  const { data, refetch } = useApi<RuntimeActivity>('/coder/activity');
  const runtime = data && Array.isArray(data.active) ? data : null;
  const executing = useMemo(() => executingSessionIds(sessions ?? [], live, runtime), [sessions, live, runtime]);
  // Only active views/runs poll, and each poll reads one in-memory worker map.
  usePolling(refetch, 5000, { enabled: executing.size > 0 || !!runtime?.active.length, immediate: false });
  useEffect(() => {
    window.addEventListener('coder:sessions-changed', refetch);
    window.addEventListener('focus', refetch);
    return () => {
      window.removeEventListener('coder:sessions-changed', refetch);
      window.removeEventListener('focus', refetch);
    };
  }, [refetch]);
  return executing;
}
