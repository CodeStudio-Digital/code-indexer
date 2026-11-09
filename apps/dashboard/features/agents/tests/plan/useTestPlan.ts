/** On-demand plan projection. Cancels obsolete session/service requests. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadTestPlan } from './test-plan-data.js';

type PlanData = Awaited<ReturnType<typeof loadTestPlan>>;
export function useTestPlan(sessionId: string, serviceId = 'main') {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: PlanData | null }>({ loading: true, error: null, data: null });
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const data = await loadTestPlan(sessionId, serviceId, controller.signal);
      if (!controller.signal.aborted) setState({ loading: false, error: null, data });
    } catch (error) {
      if (!controller.signal.aborted) setState({ loading: false, error: error instanceof Error ? error.message : String(error), data: null });
    }
  }, [sessionId, serviceId]);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);
  return { ...state, refresh };
}
