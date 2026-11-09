import { useCallback } from 'react';
import { fetchRuns } from '../api/qa-api.js';
import { useScopedPoll } from '../shared/useScopedPoll.js';

const delay = (value: Awaited<ReturnType<typeof fetchRuns>> | null) => value?.runs.some((run) => run.status === 'running') ? 4000 : 12000;

export function useRunHistory(sessionId: string, opts?: { pollWhenActive?: boolean; serviceId?: string }) {
  const serviceId = opts?.serviceId;
  const read = useCallback((signal: AbortSignal) => fetchRuns({ sessionId, serviceId, limit: 50, signal }), [sessionId, serviceId]);
  const state = useScopedPoll(`${sessionId}:${serviceId ?? 'main'}`, read, delay);
  return { runs: state.value?.runs ?? [], loading: state.loading, error: state.error, refresh: state.refresh };
}
