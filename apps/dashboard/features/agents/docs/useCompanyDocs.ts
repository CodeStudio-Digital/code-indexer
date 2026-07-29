/**
 * Data hooks for the company Docs tab (extracted from DocsTab in phase
 * D2 when the endpoints grew provenance + RAG state).
 *
 * Defensive parsing everywhere: the dashboard ships without tsc, so
 * every network payload is treated as untrusted — missing fields
 * degrade to the pre-D2 behavior (origin 'sandbox', no mtime).
 */
import { useCallback, useEffect, useState } from 'react';

export type DocOrigin = 'sandbox' | 'drive_mirror';

export interface DocEntry {
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
} {
  const [entries, setEntries] = useState<DocEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const url =
      `/api/company/sessions/${sessionId}/docs/list` +
      (service ? `?service=${encodeURIComponent(service)}` : '');
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (!cancelled) setEntries(coerceEntries(body));
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, nonce]);

  return { entries, loading, reload: () => setNonce((n) => n + 1) };
}

export interface DocBody {
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
  if (!res.ok) return { content: '', origin: null, mtime: null };
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

export function useDocBody(sessionId: string, service: string | null, path: string | null): DocBody {
  const [state, setState] = useState<DocBody>({ body: '', origin: null, mtime: null, loading: false });
  useEffect(() => {
    if (!path) {
      setState({ body: '', origin: null, mtime: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetchDocBody(sessionId, service, path)
      .then((r) => {
        if (!cancelled) setState({ body: r.content, origin: r.origin, mtime: r.mtime, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ body: '', origin: null, mtime: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, path]);
  return state;
}

export type RagState = 'unknown' | 'not_indexed' | 'indexing' | 'indexed' | 'error';

/**
 * RAG status + trigger for the SELECTED doc. Optimistic: `index()`
 * flips to 'indexing' immediately and reverts on failure.
 */
export function useDocsRag(sessionId: string, service: string | null, path: string | null): {
  state: RagState;
  index: () => void;
} {
  const [state, setState] = useState<RagState>('unknown');

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
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled) return;
        const indexed = (body as { indexed?: unknown } | null)?.indexed === true;
        setState(indexed ? 'indexed' : 'not_indexed');
      })
      .catch(() => {
        if (!cancelled) setState('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, path]);

  const index = useCallback(() => {
    if (!path) return;
    const prev = state;
    setState('indexing');
    fetch(`/api/company/sessions/${sessionId}/docs/index-rag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...(service ? { service } : {}) }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setState('indexed');
      })
      .catch(() => {
        // Revert to whatever we knew before the optimistic flip.
        setState(prev === 'indexed' ? 'indexed' : 'error');
      });
  }, [sessionId, service, path, state]);

  return { state, index };
}
