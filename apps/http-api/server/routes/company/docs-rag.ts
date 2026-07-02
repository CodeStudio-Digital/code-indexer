/**
 * Docs → RAG bridge (phase D2).
 *
 *   POST /api/company/sessions/:id/docs/index-rag  { service?, path }
 *   GET  /api/company/sessions/:id/docs/rag-status ?service=&path=
 *
 * Takes a doc authored via `docs_write` (read through the same
 * sandbox-or-mirror resolution the Docs tab uses) and ingests it into
 * the documentation corpus through the REAL ingestion pipeline
 * (`runIngest` — chunk → enrich → embed → upsert), so `rag_search_docs`
 * can retrieve it.
 *
 * Project resolution: the corpus scopes retrieval per project via
 * doc_collections ↔ project links (migration 134). We link the bridge
 * collection to the session's FIRST linked project
 * (`company_session_projects`, falling back to the parent session's
 * links for sub-sessions — same rule as `SessionContext.loadProjects`).
 *
 * Indexed-state: one doc = one `doc_sources` row keyed by the stable
 * URI `companydoc://<scope>/<service>/<path>`; `rag-status` reports
 * `indexed` when that row exists with status 'done' — no extra
 * bookkeeping table needed.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { checkRelativePath } from '@mcp/company/tools/file-path-core.js';
import { DocError } from '@mcp/services/services/docs/index.js';
import { runIngest } from '@mcp/services/services/docs/index-doc-use-case/run-ingest.js';
import type { IndexDocUseCaseDeps } from '@mcp/services/services/docs/index-doc-use-case/types.js';
import type { RawPage } from '@mcp/services/services/docs/types.js';
import type { DocCollection, DocSource } from '@mcp/store/doc-store.js';
import { normalizeDocServiceId, readCompanyDoc, resolveDocsScopeKey } from './docs.js';

function docUri(scopeKey: string, service: string, path: string): string {
  return `companydoc://${scopeKey}/${service}/${path}`;
}

function collectionName(scopeKey: string): string {
  return `company-docs:${scopeKey}`;
}

/**
 * First project linked to the session (parent fallback for
 * sub-sessions). Null when the company has no linked project — the
 * corpus is global, but without a link the agents' scoped retrieval
 * would never surface the doc, so we refuse instead of mis-filing.
 */
function resolveLinkedProjectId(deps: ServerDeps, sessionId: number): number | null {
  const own = deps.companyStore.listCompanySessionProjects(sessionId);
  if (own.length > 0) return own[0]!.project_id;
  const session = deps.companyStore.getCompanySession(sessionId);
  const parentId = (session as { parent_session_id?: number | null } | null)?.parent_session_id;
  if (parentId == null) return null;
  const parent = deps.companyStore.listCompanySessionProjects(parentId);
  return parent.length > 0 ? parent[0]!.project_id : null;
}

function ensureBridgeCollection(deps: ServerDeps, scopeKey: string): DocCollection {
  const name = collectionName(scopeKey);
  const existing = deps.docStore.getCollectionByName(name);
  if (existing) return existing;
  return deps.docStore.createCollection({
    name,
    description: `Company docs mirror (${scopeKey}) indexed for RAG retrieval`,
  });
}

function findSource(deps: ServerDeps, collectionId: number, uri: string): DocSource | undefined {
  return deps.docStore.listSourcesByCollection(collectionId).find((s) => s.uri === uri);
}

function ingestDeps(deps: ServerDeps, sessionId: number): IndexDocUseCaseDeps {
  return {
    docStore: deps.docStore,
    embeddingService: deps.embeddingService,
    vectorStore: deps.vectorStore,
    pipelineProviderResolver: deps.pipelineProviderResolver,
    progressTracker: deps.docProgressTracker,
    resolveContext: { companySessionId: sessionId },
  };
}

export function mountCompanyDocsRagRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/company/sessions/:id/docs/index-rag', async (c) => {
    const id = parseIdParam(c);
    if (!deps.companyStore.getCompanySession(id)) return notFound(c);
    const body = await parseJsonBody<{ service?: string; path?: string }>(c);
    const path = typeof body.path === 'string' ? body.path : '';
    if (!checkRelativePath(path, { traversal: 'substring' }).ok) {
      return c.json({ error: 'invalid path' }, 400);
    }
    const serviceId = typeof body.service === 'string' && body.service ? body.service : null;

    const doc = await readCompanyDoc(deps, id, serviceId, path);
    if (!doc) return c.json({ error: `doc not found: ${path}` }, 404);

    const projectId = resolveLinkedProjectId(deps, id);
    if (projectId == null) {
      return c.json(
        { error: 'no_linked_project', message: 'Link a project to this company session first' },
        409,
      );
    }

    const scopeKey = resolveDocsScopeKey(deps, id);
    const svc = normalizeDocServiceId(serviceId);
    const uri = docUri(scopeKey, svc, path);
    try {
      const collection = ensureBridgeCollection(deps, scopeKey);
      // Idempotent: re-linking an already linked pair is a no-op.
      deps.docStore.linkProjectCollection(projectId, collection.id, 'auto');
      const source =
        findSource(deps, collection.id, uri) ??
        deps.docStore.createSource({
          collection_id: collection.id,
          type: 'url',
          uri,
          title: `${svc}/${path}`,
        });
      const page: RawPage = {
        candidateId: uri,
        uri,
        title: `${svc}/${path}`,
        markdown: doc.content,
        source: 'folder',
      };
      // skipGate: these docs are agent-curated ADRs/runbooks — same
      // rationale as folder sources bypassing the LLM relevance gate.
      const result = await runIngest(
        ingestDeps(deps, id), collection, source, async () => [page], undefined, { skipGate: true },
      );
      return c.json({
        ok: true,
        docId: source.id,
        chunks: result.chunks_indexed,
        collectionId: collection.id,
        projectId,
        origin: doc.origin,
      });
    } catch (e) {
      if (e instanceof DocError && e.kind === 'already_running') {
        return c.json({ error: 'already_running' }, 409);
      }
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get('/api/company/sessions/:id/docs/rag-status', (c) => {
    const id = parseIdParam(c);
    if (!deps.companyStore.getCompanySession(id)) return notFound(c);
    const path = c.req.query('path') || '';
    if (!checkRelativePath(path, { traversal: 'substring' }).ok) {
      return c.json({ error: 'invalid path' }, 400);
    }
    const serviceId = c.req.query('service') || null;
    const scopeKey = resolveDocsScopeKey(deps, id);
    const collection = deps.docStore.getCollectionByName(collectionName(scopeKey));
    if (!collection) return c.json({ indexed: false });
    const uri = docUri(scopeKey, normalizeDocServiceId(serviceId), path);
    const source = findSource(deps, collection.id, uri);
    const indexed = !!source && source.status === 'done' && source.last_indexed_at != null;
    return c.json({
      indexed,
      lastIndexedAt: source?.last_indexed_at ?? null,
      sourceId: source?.id ?? null,
    });
  });
}
