/**
 * Hook: list microservices of a company session for the Tab Testes
 * switcher. Wraps `GET /api/company/sessions/:id/services`.
 *
 * Single-service sessions return `[{service_id:'main', is_primary:true, ...}]`
 * — the consumer hides the switcher when length <= 1. Multi-service
 * sessions get an entry per container including the primary.
 *
 * Refresh: once on mount + a soft 8s poll. Picks up new services
 * spawned mid-session (e.g. agent provisions an `api` worker after
 * the QA team starts) without forcing the user to refresh.
 */
import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 8_000;

export interface SessionService {
  service_id: string;
  name: string;
  stack: string;
  status: string;
  is_primary: boolean;
  preview_url: string | null;
}

export interface UseSessionServicesResult {
  services: SessionService[];
  loading: boolean;
  error: string | null;
}

export function useSessionServices(sessionId: string): UseSessionServicesResult {
  const [services, setServices] = useState<SessionService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      try {
        const res = await fetch(`/api/company/sessions/${sessionId}/services`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as { services?: SessionService[] };
        if (cancelledRef.current) return;
        const list = (body.services ?? []).map((s) => ({
          service_id: s.service_id,
          name: s.name || s.service_id,
          stack: s.stack,
          status: s.status,
          is_primary: !!s.is_primary,
          preview_url: s.preview_url ?? null,
        }));
        // Always surface a `main` entry when there's a primary that's
        // missing the explicit row — preserves single-service sessions
        // that pre-date the services persistence.
        if (list.length === 0) {
          list.push({
            service_id: 'main',
            name: 'main',
            stack: '',
            status: 'unknown',
            is_primary: true,
            preview_url: null,
          });
        }
        setServices(list);
        setError(null);
      } catch (e) {
        if (!cancelledRef.current) setError((e as Error).message);
      } finally {
        if (!cancelledRef.current) setLoading(false);
        if (!cancelledRef.current) {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      }
    }

    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  return { services, loading, error };
}
