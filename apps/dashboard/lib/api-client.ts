/**
 * Transport-agnostic client for the @mcp/api-bus surface.
 *
 * Two callsite shapes:
 *   - `apiCall('projects.list', undefined)` — Promise<T>
 *   - `apiStream('coder.stream.sendMessage', input)` — AsyncIterable<T>
 *
 * In Electron, `window.electronAPI.api.*` is the source of truth — every
 * call goes over IPC (zero HTTP), and streams arrive on a MessagePort.
 * In the browser dev server (vite dev), the same calls fall back to
 * fetch against the Hono routes / EventSource against SSE endpoints.
 *
 * This file replaces `useApi(url)` for new code — existing useApi
 * callsites keep working unchanged so the migration is incremental.
 */

import type { Api } from '@mcp/api-bus';

type DotPath = string;

/**
 * Base URL for HTTP fetches against the backend. Inside Electron we
 * deliberately bypass the Vite dev proxy and hit the Hono listener on
 * 127.0.0.1:3333 directly — the proxy was eating SSE flushes in
 * practice even with `x-accel-buffering: no`, causing the chat to hang
 * at "iniciando…".
 *
 * Override at runtime via `window.__MCP_API_BASE__` if you need to point
 * at a different host (e.g. tunneled remote backend). In the browser
 * dev mode the empty string keeps requests relative so Vite's proxy
 * still handles them.
 */
export function apiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const override = (window as unknown as { __MCP_API_BASE__?: string }).__MCP_API_BASE__;
  if (typeof override === 'string') return override;
  if (window.electronAPI) return 'http://127.0.0.1:3333';
  return '';
}

/** Resolve a dotted method path to the function on `electronAPI.api`. */
function resolveElectronMethod(path: DotPath): ((input: unknown) => unknown) | null {
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!electron) return null;
  const parts = path.split('.');
  let cur: unknown = electron.api;
  for (const part of parts) {
    if (cur == null) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'function' ? (cur as (input: unknown) => unknown) : null;
}

/**
 * Map a dotted method path to a Hono REST endpoint (best-effort, used
 * only in the browser fallback). Coverage is the IDE-hot subset; less
 * common methods fall through to a thrown error so we don't silently
 * shadow a missing implementation.
 */
function dottedToHttp(path: DotPath, input: unknown): { url: string; init: RequestInit } | null {
  const json = (b: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  const ip = input as Record<string, unknown> | undefined;
  switch (path) {
    case 'projects.list':
      return { url: '/api/projects', init: {} };
    case 'projects.get':
      return { url: `/api/projects/${ip!.id}`, init: {} };
    case 'projects.stats':
      return { url: `/api/projects/${ip!.id}/stats`, init: {} };
    case 'files.list':
      return { url: `/api/projects/${ip!.projectId}/files`, init: {} };
    case 'files.tree':
      return { url: `/api/projects/${ip!.projectId}/file-tree?root=${encodeURIComponent(String(ip!.root ?? '.'))}`, init: {} };
    case 'files.read':
      return { url: `/api/projects/${ip!.projectId}/file?path=${encodeURIComponent(String(ip!.path))}`, init: {} };
    case 'files.write':
      return { url: `/api/projects/${ip!.projectId}/file`, init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ip!.path, content: ip!.content }) } };
    case 'files.delete':
      return {
        url: `/api/projects/${ip!.projectId}/file?path=${encodeURIComponent(String(ip!.path))}${ip!.recursive ? '&recursive=1' : ''}`,
        init: { method: 'DELETE' },
      };
    case 'files.rename':
      return {
        url: `/api/projects/${ip!.projectId}/file/rename`,
        init: json({ from: ip!.from, to: ip!.to }),
      };
    case 'files.mkdir':
      return {
        url: `/api/projects/${ip!.projectId}/dir`,
        init: json({ path: ip!.path }),
      };
    case 'lsp.completion':
    case 'lsp.hover':
    case 'lsp.definition':
    case 'lsp.references':
    case 'lsp.diagnostics': {
      const op = path.split('.')[1];
      return { url: `/api/lsp/${ip!.projectId}/${op}`, init: json({ file: ip!.file, position: ip!.position }) };
    }
    default:
      return null;
  }
}

/**
 * One-shot RPC call. Prefers Electron IPC; falls back to HTTP for the
 * methods we've mapped in `dottedToHttp`.
 */
export async function apiCall<T>(path: DotPath, input?: unknown): Promise<T> {
  const electronFn = resolveElectronMethod(path);
  if (electronFn) {
    const wrapped = (await electronFn(input)) as { ok: boolean; value?: T; error?: { message: string; code?: string; status?: number } };
    if (!wrapped.ok) {
      const err = wrapped.error ?? { message: 'unknown ipc error' };
      const e = new Error(err.message) as Error & { code?: string; status?: number };
      if (err.code) e.code = err.code;
      if (err.status) e.status = err.status;
      throw e;
    }
    return wrapped.value as T;
  }
  // HTTP fallback
  const mapped = dottedToHttp(path, input);
  if (!mapped) {
    throw new Error(`apiCall("${path}"): no HTTP fallback mapped — this method is Electron-only or needs a mapping entry`);
  }
  const res = await fetch(mapped.url, mapped.init);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  // Some routes return text (e.g. snapshots.getForContext); detect by header.
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

/**
 * Streaming RPC call. Electron returns an AsyncIterable backed by a
 * MessagePort; the browser fallback wraps EventSource into an iterable
 * with the same surface. Both end naturally when the producer closes.
 */
export function apiStream<T>(path: DotPath, input?: unknown): AsyncIterable<T> {
  const electronFn = resolveElectronMethod(path);
  if (electronFn) {
    return electronFn(input) as AsyncIterable<T>;
  }
  // Browser fallback — only the streams we explicitly handle today.
  // Returns an iterable that throws on first iteration if unmapped, so
  // callers don't get silent empties.
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next() {
          throw new Error(
            `apiStream("${path}"): browser SSE fallback not wired yet — open the app in Electron or add a mapping`,
          );
        },
      };
    },
  };
}

/** Type-safe alias when callers want the full Api shape (Electron-only). */
export function electronApi(): Api | null {
  return (typeof window !== 'undefined' && window.electronAPI?.api) || null;
}
