import { useState, useEffect, useCallback } from 'react';
import { apiBaseUrl } from '../lib/api-client.js';

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Optimistic in-place data update (e.g. for prepending paginated results). */
  update: (fn: (prev: T) => T) => void;
}

export function useApi<T>(url: string, options?: RequestInit): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);
  const update = useCallback((fn: (prev: T) => T) => {
    setData((cur) => (cur !== null ? fn(cur) : cur));
  }, []);

  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${apiBaseUrl()}/api${url}`, options)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => {
        if (!cancelled) { setData(json as T); setLoading(false); }
      })
      .catch(err => {
        if (!cancelled) { setError(err.message); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [url, tick]);

  return { data, loading, error, refetch, update };
}

/**
 * Read the failure body and synthesise an Error whose `.message`
 * carries whatever the server sent (`{error: "..."}` JSON, plain text,
 * or just the status). Callers that want a structured failure read
 * `.status` and `.body` off the thrown error. Without this every
 * `apiPost` failure was a flat "HTTP 400" — the actual reason was in
 * the response body but got thrown away.
 */
async function failure(res: Response, fallback: string): Promise<Error> {
  let body: unknown = null;
  let message = fallback;
  const ct = res.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      body = await res.json();
      const errField = (body as Record<string, unknown> | null)?.error;
      if (typeof errField === 'string') message = errField;
    } else {
      const text = await res.text();
      if (text) {
        body = text;
        message = text.slice(0, 200);
      }
    }
  } catch {
    /* body unreadable — keep the fallback */
  }
  const err = new Error(`HTTP ${res.status}: ${message}`) as Error & {
    status?: number;
    body?: unknown;
  };
  err.status = res.status;
  err.body = body;
  return err;
}

export async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}/api${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, `POST ${url} failed`);
  return res.json() as Promise<T>;
}

export async function apiDelete(url: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/api${url}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res, `DELETE ${url} failed`);
}

export async function apiPatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}/api${url}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, `PATCH ${url} failed`);
  return res.json() as Promise<T>;
}

export async function apiPut<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}/api${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, `PUT ${url} failed`);
  return res.json() as Promise<T>;
}
