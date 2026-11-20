/**
 * Minimal HTTP client for the live bench only (bench-agent-effectiveness-live.ts).
 * The bench runs runCoder in its own process, with no worker RPC to the app,
 * so its index tools port asks the running app for vector search and namespace
 * wake-ups over HTTP. The agent's own hosts (coder and Company workers) never
 * use this file: they hand the port an RPC client.
 */
import { readBoundedJsonResponse } from '@mcp/shared/utils/bounded-json-response.js';
import {
  failed,
  parseMemoryResponse,
  parseProjectResponse,
  type McpSemanticSearchClient,
} from '@mcp/indexer/agent-tools/semantic-client.js';

type FetchLike = typeof fetch;

interface BenchHttpResult {
  reached: boolean;
  ok: boolean;
  status: number | null;
  body: unknown;
  error: string | null;
}

/** One bounded JSON request to the app: deadline after headers, caller cancellation kept apart. */
export async function requestBenchServer(
  baseUrl: string,
  path: string,
  init: RequestInit,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<BenchHttpResult> {
  init.signal?.throwIfAborted();
  const controller = new AbortController();
  const parentAbort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Local server request timed out', 'TimeoutError')), options.timeoutMs ?? 5_000);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
    const body = await readBoundedJsonResponse(response, controller.signal, options.maxResponseBytes ?? 8 * 1024 * 1024);
    controller.signal.throwIfAborted();
    return {
      reached: true, ok: response.ok, status: response.status, body,
      error: response.ok ? null : (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error) : `server returned HTTP ${response.status}`),
    };
  } catch (error) {
    // Caller cancellation is not server unavailability.
    init.signal?.throwIfAborted();
    return { reached: false, ok: false, status: null, body: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', parentAbort);
  }
}

/** Vector code and memory search through the app's HTTP API. */
export function createBenchSemanticSearchClient(baseUrl: string, fetchImpl?: FetchLike): McpSemanticSearchClient {
  const request = (path: string, headers?: Record<string, string>, signal?: AbortSignal) =>
    requestBenchServer(baseUrl, path, { method: 'GET', headers, signal }, { fetchImpl, timeoutMs: 20_000 });
  return {
    async searchProject(projectId, query, options = {}) {
      const params = new URLSearchParams({ q: query });
      if (options.mode) params.set('mode', options.mode);
      if (options.type) params.set('type', options.type);
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      params.set('consumer', options.consumer ?? 'agent');
      const headers: Record<string, string> = {};
      if (options.sessionId) headers['x-mcp-session-id'] = options.sessionId;
      if (options.companySessionId) headers['x-mcp-company-session-id'] = options.companySessionId;
      const response = await request(`/api/projects/${projectId}/search?${params}`, headers, options.signal);
      if (!response.ok) return failed(response.error);
      const value = parseProjectResponse(response.body);
      return value ? { ok: true, value, error: null } : failed('semantic server returned an invalid search payload');
    },
    async searchProjectMemory(projectId, query, limit = 5, signal) {
      const params = new URLSearchParams({ q: query, limit: String(limit), projection: 'ids' });
      const response = await request(`/api/projects/${projectId}/agent-memory/search?${params}`, undefined, signal);
      if (!response.ok) return failed(response.error);
      const value = parseMemoryResponse(response.body);
      return value ? { ok: true, value, error: null } : failed('semantic server returned an invalid memory payload');
    },
  };
}

/** Targeted namespace wake-up after a durable memory write (best effort). */
export function createBenchNamespaceWake(baseUrl: string, fetchImpl?: FetchLike): (namespace: string) => Promise<void> {
  return namespace => requestBenchServer(baseUrl, '/api/semantic/namespaces/reconcile',
    { method: 'POST', body: JSON.stringify({ namespace }) }, { fetchImpl }).then(() => undefined);
}
