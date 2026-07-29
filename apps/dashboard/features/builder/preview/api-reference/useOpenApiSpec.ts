import { useEffect, useRef, useState } from 'react';

export interface OpenApiSpecState {
  spec: unknown | null;
  loading: boolean;
  /**
   * `not_found` = endpoint returned 404 (no openapi.{yaml,yml,json} in workdir).
   * `error`     = any other failure (parse, network, 5xx).
   * `null`      = no error.
   */
  errorKind: 'not_found' | 'error' | null;
  errorMessage: string | null;
  /** Source path inside the sandbox (e.g. `openapi.yaml`). Useful for status text. */
  sourcePath: string | null;
}

/**
 * Fetches the OpenAPI document for `(sessionId, serviceId)` from the
 * http-api. Re-runs on `reloadKey` bumps so callers can refetch when
 * the agent saves a new version (driven by `sandbox.file_changed` SSE
 * via `fileChangeTick` upstream). Cancels in-flight requests with
 * AbortController so a fast service switch doesn't race.
 */
export function useOpenApiSpec(
  sessionId: string,
  serviceId: string | null,
  reloadKey = 0,
): OpenApiSpecState {
  const [state, setState] = useState<OpenApiSpecState>({
    spec: null,
    loading: false,
    errorKind: null,
    errorMessage: null,
    sourcePath: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!serviceId) {
      setState({
        spec: null,
        loading: false,
        errorKind: null,
        errorMessage: null,
        sourcePath: null,
      });
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState((s) => ({ ...s, loading: true, errorKind: null, errorMessage: null }));
    const url = `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/openapi`;
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 404) {
          setState({
            spec: null,
            loading: false,
            errorKind: 'not_found',
            errorMessage: null,
            sourcePath: null,
          });
          return;
        }
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          setState({
            spec: null,
            loading: false,
            errorKind: 'error',
            errorMessage: `HTTP ${r.status} ${txt}`.trim(),
            sourcePath: null,
          });
          return;
        }
        const body = (await r.json()) as { spec?: unknown; sourcePath?: string };
        setState({
          spec: body.spec ?? null,
          loading: false,
          errorKind: body.spec ? null : 'error',
          errorMessage: body.spec ? null : 'Empty spec returned',
          sourcePath: body.sourcePath ?? null,
        });
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setState({
          spec: null,
          loading: false,
          errorKind: 'error',
          errorMessage: e instanceof Error ? e.message : String(e),
          sourcePath: null,
        });
      });
    return () => ctrl.abort();
  }, [sessionId, serviceId, reloadKey]);

  return state;
}
