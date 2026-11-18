/**
 * Thin fetch wrappers over the api-client Hono routes. Uses direct fetch
 * against `apiBaseUrl()` (resolves to `mcp://app` in Electron, relative in
 * browser dev) — same pattern as SessionDrivePanel — so no IPC/api-bus
 * mapping is required.
 */
import { apiBaseUrl } from '../../lib/api-client.js';
import type { ApiCollection, ApiEnvironment, ApiRequest, SendResponse, RunReport, ApiRegressionRun, ImportResult, ApiRequestHistory } from './types.js';

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

// ─── Folders ───────────────────────────────────────────────────────────
export const addFolder = (p: number, cid: number, name: string) =>
  req<ApiCollection>(`${root(p)}/collections/${cid}/folders`, j({ name }));
export const renameFolder = (p: number, cid: number, from: string, to: string) =>
  req<ApiCollection>(`${root(p)}/collections/${cid}/folders`, { method: 'PATCH', body: JSON.stringify({ from, to }) });
export const deleteFolder = (p: number, cid: number, name: string) =>
  req<ApiCollection>(`${root(p)}/collections/${cid}/folders/${encodeURIComponent(name)}`, { method: 'DELETE' });
export const listFolders = (p: number, cid: number) =>
  req<{ folders: string[] }>(`${root(p)}/collections/${cid}/folders`).then((r) => r.folders);

// ─── AI script assistant ───────────────────────────────────────────────
export interface ScriptAssistPayload {
  target: 'pre' | 'test';
  intent: string;
  request: { method: string; url: string; headerNames: string[]; bodyKind: string; bodySample?: string };
  responseShape?: string;
  existing?: string;
}
export const scriptAssist = (p: number, payload: ScriptAssistPayload) =>
  req<{ script: string; explanation: string }>(`${root(p)}/script-assist`, j(payload));

// ─── Requests ──────────────────────────────────────────────────────────
export const listRequests = (p: number, cid: number) =>
  req<{ requests: ApiRequest[] }>(`${root(p)}/collections/${cid}/requests`).then((r) => r.requests);
export const createRequest = (p: number, cid: number, input: Partial<ApiRequest> & { name: string }) =>
  req<ApiRequest>(`${root(p)}/collections/${cid}/requests`, j(input));
export const patchRequest = (p: number, rid: number, patch: Partial<ApiRequest>) =>
  req<ApiRequest>(`${root(p)}/requests/${rid}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteRequest = (p: number, rid: number) =>
  req<{ ok: true }>(`${root(p)}/requests/${rid}`, { method: 'DELETE' });
export const duplicateRequest = (p: number, rid: number) =>
  req<ApiRequest>(`${root(p)}/requests/${rid}/duplicate`, { method: 'POST' });
export const reorderRequests = (p: number, cid: number, orderedIds: number[], folder: string | null) =>
  req<{ ok: true }>(`${root(p)}/collections/${cid}/reorder`, j({ orderedIds, folder }));
async function manualSend(p: number, path: string, body: unknown, signal?: AbortSignal): Promise<SendResponse> {
  if (!signal) return req<SendResponse>(root(p) + path, j(body));
  signal.throwIfAborted();
  const reservations = root(p) + '/sends';
  const { id } = await req<{ id: string }>(reservations, { method: 'POST' });
  const cancel = () => { void req(reservations + '/' + id, { method: 'DELETE', keepalive: true }).catch(() => {}); };
  if (signal.aborted) { cancel(); signal.throwIfAborted(); }
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await req<SendResponse>(root(p) + path, {
      ...j(body), signal, headers: { 'Content-Type': 'application/json', 'X-CodeStudio-Send-Id': id },
    });
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
export const sendRequest = (p: number, rid: number, envId?: number, signal?: AbortSignal) =>
  manualSend(p, `/requests/${rid}/send`, { envId }, signal);
/** Send an unsaved draft request (no DB row) — posts the full request fields. */
export const sendAdhoc = (p: number, request: Partial<ApiRequest>, envId?: number, signal?: AbortSignal) =>
  manualSend(p, '/send-adhoc', { request, envId }, signal);
export const verifyRequest = (p: number, rid: number, expectedStatus: number, assert?: unknown) =>
  req<ApiRequest>(`${root(p)}/requests/${rid}/verify`, j({ expectedStatus, assert }));
export const listRequestHistory = (p: number, rid: number, limit = 50) =>
  req<{ history: ApiRequestHistory[] }>(`${root(p)}/requests/${rid}/history?limit=${limit}`).then((r) => r.history);

// ─── Environments ──────────────────────────────────────────────────────
export const listEnvironments = (p: number) =>
  req<{ environments: ApiEnvironment[] }>(`${root(p)}/environments`).then((r) => r.environments);
export const upsertEnvironment = (p: number, input: {
  id?: number; name: string; base_url?: string; variables?: Record<string, unknown>; is_default?: boolean;
}) => req<ApiEnvironment>(`${root(p)}/environments`, { method: 'PUT', body: JSON.stringify(input) });
export const deleteEnvironment = (p: number, eid: number) =>
  req<{ ok: true }>(`${root(p)}/environments/${eid}`, { method: 'DELETE' });

// ─── Codegen + curl import + export ────────────────────────────────────
export interface CodegenResponse { target: string; language: string; code: string; containsSecrets: boolean; }
export const generateCode = (p: number, rid: number, target: string, resolve: boolean, envId?: number) =>
  req<CodegenResponse>(`${root(p)}/requests/${rid}/codegen`, j({ target, resolve, envId }));
export const importCurl = (p: number, cid: number, text: string) =>
  req<{ request: ApiRequest }>(`${root(p)}/collections/${cid}/import-curl`, j({ text })).then((r) => r.request);
export const exportCollection = (p: number, cid: number, format: 'postman' | 'openapi') =>
  req<unknown>(`${root(p)}/collections/${cid}/export?format=${format}`);

// ─── OpenAPI import + regression ───────────────────────────────────────
export const importOpenApi = (p: number, specPath?: string) =>
  req<ImportResult>(`${root(p)}/collections/import-openapi`, j({ specPath: specPath || undefined }));
export const importOpenApiContent = (p: number, content: string, filename?: string) =>
  req<ImportResult>(`${root(p)}/collections/import-openapi-content`, j({ content, filename }));
export interface PostmanPreview {
  name: string; requests: number; folders: number; variables: number; scripts: number; skipped: number; examples: number;
  collectionId?: number;
}
export const importPostman = (p: number, content: string, importId: string, commit: boolean, createEnvironment = false) =>
  req<PostmanPreview>(`${root(p)}/collections/import-postman`, j({ content, importId, commit, createEnvironment }));
export const runCollection = (p: number, cid: number, opts: { envId?: number; includeMutating?: boolean }) =>
  req<RunReport>(`${root(p)}/collections/${cid}/run`, j(opts));
export const listRuns = (p: number, cid: number) =>
  req<{ runs: ApiRegressionRun[] }>(`${root(p)}/collections/${cid}/runs`).then((r) => r.runs);
