/**
 * Data hooks for the company Docs tab (extracted from DocsTab in phase
 * D2 when the endpoints grew provenance + RAG state).
 *
 * Defensive parsing everywhere: the dashboard ships without tsc, so
 * every network payload is treated as untrusted — missing fields
 * degrade to the pre-D2 behavior (origin 'sandbox', no mtime).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type DocOrigin = 'sandbox' | 'drive_mirror';

interface DocEntry {
  path: string;
  origin: DocOrigin;
  mtime: string | null;
}

function coerceEntries(body: unknown): DocEntry[] {
  const b = body as { entries?: unknown; items?: unknown } | null;
  if (Array.isArray(b?.entries)) {
    return (b!.entries as Array<Record<string, unknown>>)
      .filter((e) => typeof e?.path === 'string')
      .map((e) => ({
        path: e.path as string,
        origin: e.origin === 'drive_mirror' ? 'drive_mirror' : 'sandbox',
        mtime: typeof e.mtime === 'string' ? e.mtime : null,
      }));
  }
  if (Array.isArray(b?.items)) {
    return (b!.items as unknown[])
      .filter((p): p is string => typeof p === 'string')
      .map((path) => ({ path, origin: 'sandbox' as const, mtime: null }));
  }
  return [];
}

export function useDocsList(sessionId: string, service: string | null): {
  entries: DocEntry[];
  reload: () => void;
  loading: boolean;
  error: string | null;
  revision: number;
  services: Array<{ service_id: string; name: string }>;
} {
  const [entries, setEntries] = useState<DocEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [services, setServices] = useState<Array<{ service_id: string; name: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries([]);
    const url =
      `/api/company/sessions/${sessionId}/docs/list` +
      (service ? `?service=${encodeURIComponent(service)}` : '');
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((body: unknown) => {
        if (!cancelled) {
          setEntries(coerceEntries(body));
          const incoming = (body as { services?: Array<{ service_id: string; name: string }> }).services;
          setServices(Array.isArray(incoming) ? incoming : []);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, nonce]);

  return { entries, loading, error, services, revision: nonce, reload: () => setNonce((n) => n + 1) };
}

interface DocBody {
  error: string | null;
  body: string;
  origin: DocOrigin | null;
  mtime: string | null;
  loading: boolean;
}

/** Fetch + parse a doc body. Exported for `useIndexFile` reuse. */
export async function fetchDocBody(
  sessionId: string,
  service: string | null,
  path: string,
): Promise<{ content: string; origin: DocOrigin | null; mtime: string | null }> {
  const qs = new URLSearchParams({ path });
  if (service) qs.set('service', service);
  const res = await fetch(`/api/company/sessions/${sessionId}/docs/read?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { content?: unknown; origin?: unknown; mtime?: unknown };
    if (typeof json?.content === 'string') {
      return {
        content: json.content,
        origin: json.origin === 'drive_mirror' ? 'drive_mirror' : 'sandbox',
        mtime: typeof json.mtime === 'string' ? json.mtime : null,
      };
    }
  } catch {
    // Older server (pre-D2) returned the raw markdown — keep working.
  }
  return { content: text, origin: null, mtime: null };
}

export function useDocBody(sessionId: string, service: string | null, path: string | null, revision = 0): DocBody {
  const [state, setState] = useState<DocBody>({ body: '', origin: null, mtime: null, loading: false, error: null });
  useEffect(() => {
    if (!path) {
      setState({ body: '', origin: null, mtime: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ body: '', origin: null, mtime: null, loading: true, error: null });
    fetchDocBody(sessionId, service, path)
      .then((r) => {
        if (!cancelled) setState({ body: r.content, origin: r.origin, mtime: r.mtime, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ body: '', origin: null, mtime: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, path, revision]);
  return state;
}

type RagState = 'stale' | 'unknown' | 'not_indexed' | 'indexing' | 'indexed' | 'error';

/**
 * RAG status + trigger for the SELECTED doc. Optimistic: `index()`
 * flips to 'indexing' immediately and reverts on failure.
 */
export function useDocsRag(sessionId: string, service: string | null, path: string | null, revision = 0): {
  state: RagState;
  index: () => void;
} {
  const [state, setState] = useState<RagState>('unknown');
  const currentKey = `${sessionId}:${service}:${path}`;
  const keyRef = useRef(currentKey);
  useEffect(() => { keyRef.current = currentKey; }, [currentKey]);

  useEffect(() => {
    if (!path) {
      setState('unknown');
      return;
    }
    let cancelled = false;
    setState('unknown');
    const qs = new URLSearchParams({ path });
    if (service) qs.set('service', service);
    fetch(`/api/company/sessions/${sessionId}/docs/rag-status?${qs.toString()}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((body: unknown) => {
        if (cancelled) return;
        const indexed = (body as { indexed?: unknown } | null)?.indexed === true;
        setState(indexed ? 'indexed' : (body as { stale?: boolean })?.stale ? 'stale' : 'not_indexed');
      })
      .catch(() => {
        if (!cancelled) setState('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, path, revision]);

  const index = useCallback(() => {
    if (!path) return;
    const requestKey = currentKey;
    setState('indexing');
    fetch(`/api/company/sessions/${sessionId}/docs/index-rag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...(service ? { service } : {}) }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (keyRef.current === requestKey) setState('indexed');
      })
      .catch(() => {
        // Revert to whatever we knew before the optimistic flip.
        if (keyRef.current === requestKey) setState('error');
      });
  }, [sessionId, service, path, currentKey]);

  return { state, index };
}
