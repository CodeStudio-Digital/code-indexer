import { useCallback } from 'react';
import { fetchActiveRun } from '../api/qa-api.js';
import { useScopedPoll } from '../shared/useScopedPoll.js';

const delay = (value: Awaited<ReturnType<typeof fetchActiveRun>> | null) => value?.run?.status === 'running' ? 2000 : 8000;

export function useLiveRun(sessionId: string, opts?: { serviceId?: string }) {
  const serviceId = opts?.serviceId;
  const read = useCallback((signal: AbortSignal) => fetchActiveRun({ sessionId, serviceId, signal }), [sessionId, serviceId]);
  const state = useScopedPoll(`${sessionId}:${serviceId ?? 'main'}`, read, delay);
  return { run: state.value?.run ?? null, results: state.value?.results ?? [], loading: state.loading, error: state.error };
}
