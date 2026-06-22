/**
 * Fetch wrappers for the Docs Studio routes (guide pages, examples, docmodel,
 * collection doc fields). Mirrors api-client/api.ts (apiBaseUrl + req<T>).
 */
import { apiBaseUrl } from '../../../lib/api-client.js';
import type { ApiDocPage, ApiRequestExample } from '../types.js';
import type { DocModel } from '../doc-shell/types.js';

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

const root = (p: number) => `/api/projects/${p}/api-client`;
const j = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });

export const getDocModel = (p: number, cid: number) => req<DocModel>(`${root(p)}/collections/${cid}/docmodel`);

export interface CollectionDocPatch { name?: string; description?: string; overview_md?: string; branding_json?: string; folder_docs_json?: string }
export const patchCollectionDocs = (p: number, cid: number, body: CollectionDocPatch) =>
  req<unknown>(`${root(p)}/collections/${cid}`, patch(body));

// ─── Guide pages ───────────────────────────────────────────────────────
export const listDocPages = (p: number, cid: number) =>
  req<{ pages: ApiDocPage[] }>(`${root(p)}/collections/${cid}/doc-pages`).then((r) => r.pages);
export const createDocPage = (p: number, cid: number, input: { title: string; body_md?: string }) =>
  req<ApiDocPage>(`${root(p)}/collections/${cid}/doc-pages`, j(input));
export const updateDocPage = (p: number, cid: number, pid: number, body: { title?: string; body_md?: string; slug?: string }) =>
  req<{ ok: true }>(`${root(p)}/collections/${cid}/doc-pages/${pid}`, patch(body));
export const deleteDocPage = (p: number, cid: number, pid: number) =>
  req<{ ok: true }>(`${root(p)}/collections/${cid}/doc-pages/${pid}`, { method: 'DELETE' });
export const reorderDocPages = (p: number, cid: number, orderedIds: number[]) =>
  req<{ ok: true }>(`${root(p)}/collections/${cid}/doc-pages/reorder`, j({ orderedIds }));

// ─── Saved examples ──────────────────────────────────────────────────────
export interface ExampleCapture {
  name: string;
  req: { method: string; url: string; headers?: Record<string, string>; body?: string | null; bodyKind?: string };
  resp: { status: number | null; statusText: string | null; headers?: Record<string, string>; body?: string | null; contentType?: string | null; size?: number | null };
}
export const listExamples = (p: number, rid: number) =>
  req<{ examples: ApiRequestExample[] }>(`${root(p)}/requests/${rid}/examples`).then((r) => r.examples);
export const createExample = (p: number, rid: number, payload: { name: string; capture: ExampleCapture }) =>
  req<ApiRequestExample>(`${root(p)}/requests/${rid}/examples`, j(payload));
export const deleteExample = (p: number, rid: number, eid: number) =>
  req<{ ok: true }>(`${root(p)}/requests/${rid}/examples/${eid}`, { method: 'DELETE' });
