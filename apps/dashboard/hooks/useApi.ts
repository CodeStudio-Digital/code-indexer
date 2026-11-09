import { useState, useEffect, useCallback } from 'react';
import { apiBaseUrl } from '../lib/api-client.js';
import { getCached, dedupe, writeThrough, invalidateAll } from '../lib/api-cache.js';
import { useSurfaceVisible } from '../lib/surface-visibility.js';
import {
  recordUseApiCacheHit,
  startUseApiRouteSpan,
} from '../lib/perf/route-startup-metrics.js';

/** Cache/dedup key for a useApi GET — must equal the fetched URL exactly so
 *  the HTTP and Electron-protocol bases never collide and query strings key
 *  distinct entries. `GET ` namespaces it apart from apiCall's `CALL ` keys. */
function getKey(url: string): string {
  return `GET ${apiBaseUrl()}/api${url}`;
}

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Optimistic in-place data update (e.g. for prepending paginated results). */
  update: (fn: (prev: T) => T) => void;
}

export function useApi<T>(url: string, options?: RequestInit): UseApiResult<T> {
  const visible = useSurfaceVisible();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);
  const update = useCallback((fn: (prev: T) => T) => {
    setData((cur) => {
      if (cur === null) return cur;
      const next = fn(cur);
      // A late session-scoped updater may deliberately reject itself by
      // returning the current value. Do not publish that unrelated current
      // payload under the updater's stale URL cache key.
      if (Object.is(next, cur)) return cur;
      // Keep same-URL siblings consistent: refresh the live cache entry so a
      // sibling useApi(sameUrl) mounting within the TTL sees the optimistic value.
      writeThrough(getKey(url), next);
      return next;
    });
  }, [url]);

  useEffect(() => {
    // Retained panes preserve their last data and revalidate on reveal. This
    // only releases this consumer; another view may own the same deduped GET.
    if (!visible) return;
    if (!url) {
      setData(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    // Uncacheable path: a caller-supplied RequestInit means custom method/
    // headers/body — never share or cache it. Plain one-shot fetch.
    if (options) {
      const finishSpan = startUseApiRouteSpan(url);
      setLoading(true);
      setError(null);
      fetch(`${apiBaseUrl()}/api${url}`, options)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(json => {
          finishSpan({ status: 'ok' });
          if (!cancelled) { setData(json as T); setLoading(false); }
        })
        .catch(err => {
          finishSpan({ status: 'error', error: errorMessage(err) });
          if (!cancelled) { setError(errorMessage(err)); setLoading(false); }
        });
      return () => { cancelled = true; };
    }

    // refetch() (tick > 0) forces a network round-trip, bypassing the cache
    // READ — but still goes through dedupe() so concurrent refetches share one
    // request and the fresh body is written to cache. Initial mount (tick === 0)
    // may serve a fresh cache hit synchronously (no loading flash).
    const force = tick > 0;
    const key = getKey(url);

    if (!force) {
      const hit = getCached<T>(key);
      if (hit !== undefined) {
        recordUseApiCacheHit(url);
        setData(hit);
        setLoading(false);
        setError(null);
        return; // cache hit — no fetch, no cleanup needed
      }
    }

    setLoading(true);
    setError(null);

    dedupe<T>(key, async () => {
      const finishSpan = startUseApiRouteSpan(url);
      try {
        const res = await fetch(`${apiBaseUrl()}/api${url}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as T;
        finishSpan({ status: 'ok' });
        return json;
      } catch (err) {
        finishSpan({ status: 'error', error: errorMessage(err) });
        throw err;
      }
    })
      .then(json => { if (!cancelled) { setData(json); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(errorMessage(err)); setLoading(false); } });

    return () => { cancelled = true; };
  }, [url, tick, options, visible]);

  return { data, loading, error, refetch, update };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  invalidateAll(); // mutation succeeded — drop the short-TTL read cache so siblings revalidate
  return res.json() as Promise<T>;
}

export async function apiDelete(url: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/api${url}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res, `DELETE ${url} failed`);
  invalidateAll();
}

export async function apiPatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}/api${url}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, `PATCH ${url} failed`);
  invalidateAll();
  return res.json() as Promise<T>;
}

export async function apiPut<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}/api${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, `PUT ${url} failed`);
  invalidateAll();
  return res.json() as Promise<T>;
}
