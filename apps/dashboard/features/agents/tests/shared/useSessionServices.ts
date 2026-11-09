import { useCallback } from 'react';
import { useScopedPoll } from './useScopedPoll.js';

interface SessionService {
  service_id: string;
  name: string;
  stack: string;
  status: string;
  is_primary: boolean;
  preview_url: string | null;
}
const delay = () => 15000;

export function useSessionServices(sessionId: string) {
  const read = useCallback(async (signal: AbortSignal): Promise<SessionService[]> => {
    const res = await fetch(`/api/company/sessions/${sessionId}/services`, { signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.json() as { services?: SessionService[] };
    const services = (body.services ?? []).map((service) => ({ ...service, name: service.name || service.service_id, is_primary: !!service.is_primary, preview_url: service.preview_url ?? null }));
    return services.length ? services : [{ service_id: 'main', name: 'main', stack: '', status: 'unknown', is_primary: true, preview_url: null }];
  }, [sessionId]);
  const state = useScopedPoll(sessionId, read, delay);
  return { services: state.value ?? [], loading: state.loading, error: state.error };
}
