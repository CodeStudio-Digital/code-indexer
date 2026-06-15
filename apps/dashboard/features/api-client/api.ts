/**
 * Thin fetch wrappers over the api-client Hono routes. Uses direct fetch
 * against `apiBaseUrl()` (resolves to `mcp://app` in Electron, relative in
 * browser dev) — same pattern as SessionDrivePanel — so no IPC/api-bus
 * mapping is required.
 */
import { apiBaseUrl } from '../../lib/api-client.js';
import type {
  ApiBodyKind, ApiCollection, ApiEnvironment, ApiRequest, SendResponse,
  RunReport, ApiRegressionRun, ImportResult,
} from './types.js';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

const root = (projectId: number) => `/api/projects/${projectId}/api-client`;
const j = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

// ─── Collections ───────────────────────────────────────────────────────
export const listCollections = (p: number) =>
  req<{ collections: ApiCollection[] }>(`${root(p)}/collections`).then((r) => r.collections);
export const createCollection = (p: number, name: string, description?: string) =>
  req<ApiCollection>(`${root(p)}/collections`, j({ name, description }));
export const patchCollection = (p: number, cid: number, patch: { name?: string; description?: string }) =>
  req<ApiCollection>(`${root(p)}/collections/${cid}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteCollection = (p: number, cid: number) =>
  req<{ ok: true }>(`${root(p)}/collections/${cid}`, { method: 'DELETE' });

// ─── Requests ──────────────────────────────────────────────────────────
export const listRequests = (p: number, cid: number) =>
  req<{ requests: ApiRequest[] }>(`${root(p)}/collections/${cid}/requests`).then((r) => r.requests);
export const createRequest = (p: number, cid: number, input: Partial<ApiRequest> & { name: string }) =>
  req<ApiRequest>(`${root(p)}/collections/${cid}/requests`, j(input));
export const patchRequest = (p: number, rid: number, patch: Partial<ApiRequest>) =>
  req<ApiRequest>(`${root(p)}/requests/${rid}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteRequest = (p: number, rid: number) =>
  req<{ ok: true }>(`${root(p)}/requests/${rid}`, { method: 'DELETE' });
export const sendRequest = (p: number, rid: number, envId?: number) =>
  req<SendResponse>(`${root(p)}/requests/${rid}/send`, j({ envId }));
export const verifyRequest = (p: number, rid: number, expectedStatus: number, assert?: unknown) =>
  req<ApiRequest>(`${root(p)}/requests/${rid}/verify`, j({ expectedStatus, assert }));

// ─── Environments ──────────────────────────────────────────────────────
export const listEnvironments = (p: number) =>
  req<{ environments: ApiEnvironment[] }>(`${root(p)}/environments`).then((r) => r.environments);
export const upsertEnvironment = (p: number, input: {
  id?: number; name: string; base_url?: string; variables?: Record<string, unknown>; is_default?: boolean;
}) => req<ApiEnvironment>(`${root(p)}/environments`, { method: 'PUT', body: JSON.stringify(input) });
export const deleteEnvironment = (p: number, eid: number) =>
  req<{ ok: true }>(`${root(p)}/environments/${eid}`, { method: 'DELETE' });

// ─── OpenAPI import + regression ───────────────────────────────────────
export const importOpenApi = (p: number, specPath?: string) =>
  req<ImportResult>(`${root(p)}/collections/import-openapi`, j({ specPath: specPath || undefined }));
export const runCollection = (p: number, cid: number, opts: { envId?: number; includeMutating?: boolean }) =>
  req<RunReport>(`${root(p)}/collections/${cid}/run`, j(opts));
export const listRuns = (p: number, cid: number) =>
  req<{ runs: ApiRegressionRun[] }>(`${root(p)}/collections/${cid}/runs`).then((r) => r.runs);

export type { ApiBodyKind };
