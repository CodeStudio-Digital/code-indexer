import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { collectionInProject, requestInProject } from './_ownership.js';
import { buildDocModel } from '@mcp/services/api-client/docmodel/build-doc-model.js';
import { redactExample, type ExampleCapture } from '@mcp/services/api-client/docmodel/redact-example.js';
import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import type { ApiRequestExample } from '@mcp/store/api-client-types.js';

/**
 * Docs Studio routes — guide pages + saved examples (mig 172) + the assembled
 * DocModel. All project-scoped under /api/projects/:projectId/api-client.
 * Examples are RE-REDACTED server-side on write (never trust the client strip).
 */
export function mountApiDocRoutes(app: HttpRouter, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/api-client';

  // ─── Guide pages ─────────────────────────────────────────────────────
  app.get(`${base}/collections/:cid/doc-pages`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return c.json({ pages: [] });
    return c.json({ pages: store.listDocPages(cid) });
  });

  app.post(`${base}/collections/:cid/doc-pages`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ title?: string; slug?: string; body_md?: string }>(c);
    const title = body.title?.trim() || 'Untitled';
    const existing = store.listDocPages(cid);
    const slug = uniqueSlug(body.slug?.trim() || title, existing.map((p) => p.slug));
    return c.json(store.createDocPage({ collection_id: cid, slug, title, body_md: body.body_md ?? '', sort_order: existing.length }));
  });

  app.patch(`${base}/collections/:cid/doc-pages/:pid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    const pid = parseIdParam(c, 'pid');
    if (!docPageInCollection(store, projectId, cid, pid)) return notFound(c, `Doc page ${pid} not found`);
    const body = await parseJsonBody<{ title?: string; slug?: string; body_md?: string; sort_order?: number }>(c);
    store.updateDocPage(pid, body);
    return c.json({ ok: true });
  });

  app.delete(`${base}/collections/:cid/doc-pages/:pid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    const pid = parseIdParam(c, 'pid');
    if (!docPageInCollection(store, projectId, cid, pid)) return notFound(c, `Doc page ${pid} not found`);
    store.deleteDocPage(pid);
    return c.json({ ok: true });
  });

  app.post(`${base}/collections/:cid/doc-pages/reorder`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ orderedIds?: number[] }>(c);
    store.reorderDocPages(cid, Array.isArray(body.orderedIds) ? body.orderedIds.filter((n) => Number.isFinite(n)) : []);
    return c.json({ ok: true });
  });

  // ─── Saved examples ──────────────────────────────────────────────────
  app.get(`${base}/requests/:rid/examples`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    if (!requestInProject(store, projectId, rid)) return c.json({ examples: [] });
    return c.json({ examples: store.listExamples(rid) });
  });

  app.post(`${base}/requests/:rid/examples`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    if (!requestInProject(store, projectId, rid)) return notFound(c, `Request ${rid} not found`);
    const body = await parseJsonBody<{ name?: string; capture?: ExampleCapture }>(c);
    if (!body.capture) return c.json({ error: 'capture is required' }, 400);
    const name = body.name?.trim() || body.capture.name?.trim() || 'Example';
    // Re-redact server-side using the project's secret env values (authoritative).
    const redacted = redactExample({ ...body.capture, name }, collectSecretValues(store, projectId));
    const existing = store.listExamples(rid);
    return c.json(store.createExample({ request_id: rid, name, sort_order: existing.length, ...redacted }));
  });

  app.patch(`${base}/requests/:rid/examples/:eid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    const eid = parseIdParam(c, 'eid');
    if (!exampleInRequest(store, projectId, rid, eid)) return notFound(c, `Example ${eid} not found`);
    const body = await parseJsonBody<{ name?: string; sort_order?: number }>(c);
    store.updateExample(eid, body);
    return c.json({ ok: true });
  });

  app.delete(`${base}/requests/:rid/examples/:eid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    const eid = parseIdParam(c, 'eid');
    if (!exampleInRequest(store, projectId, rid, eid)) return notFound(c, `Example ${eid} not found`);
    store.deleteExample(eid);
    return c.json({ ok: true });
  });

  // ─── Assembled DocModel (local preview + future publish share this) ──
  app.get(`${base}/collections/:cid/docmodel`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    const col = collectionInProject(store, projectId, cid);
    if (!col) return notFound(c, `Collection ${cid} not found`);
    const requests = store.listRequests(cid);
    const examplesByRequest = new Map<number, ApiRequestExample[]>();
    for (const r of requests) { const ex = store.listExamples(r.id); if (ex.length) examplesByRequest.set(r.id, ex); }
    return c.json(buildDocModel({ collection: col, requests, docPages: store.listDocPages(cid), examplesByRequest }));
  });
}

/** A doc page iff it belongs to a collection owned by the project. */
function docPageInCollection(store: ApiClientStore, projectId: number, cid: number, pid: number): boolean {
  return !!collectionInProject(store, projectId, cid) && store.listDocPages(cid).some((p) => p.id === pid);
}

/** An example iff it belongs to a request owned by the project. */
function exampleInRequest(store: ApiClientStore, projectId: number, rid: number, eid: number): boolean {
  return !!requestInProject(store, projectId, rid) && store.listExamples(rid).some((e) => e.id === eid);
}

/** All `secret:true` env values across the project's environments (for redaction). */
function collectSecretValues(store: ApiClientStore, projectId: number): string[] {
  const out: string[] = [];
  for (const env of store.listEnvironments(projectId)) {
    try {
      const vars = JSON.parse(env.variables_json) as Record<string, { value?: string; secret?: boolean }>;
      for (const v of Object.values(vars)) if (v && typeof v === 'object' && v.secret && v.value) out.push(v.value);
    } catch { /* skip malformed */ }
  }
  return out;
}

/** url-safe slug unique within the collection. */
function uniqueSlug(input: string, taken: string[]): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
