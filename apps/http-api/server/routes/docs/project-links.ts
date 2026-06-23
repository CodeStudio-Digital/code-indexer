/**
 * /api/docs — project ↔ collection link routes (migration 134).
 *
 *   GET    /api/docs/projects/:projectId/collections          collections linked to a project
 *   GET    /api/docs/collections/:id/projects                 projects linked to a collection
 *   PUT    /api/docs/collections/:id/projects/:projectId      link  (body: { origin? })
 *   DELETE /api/docs/collections/:id/projects/:projectId      unlink
 *
 * Links only SCOPE agent retrieval (`rag_search_docs` searches linked
 * collections first); they never affect ingestion. Mounted from
 * `mountDocsRoutes` so the surface stays under /api/docs.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';

interface LinkBody {
  origin?: 'manual' | 'auto';
}

export function mountDocsProjectLinkRoutes(app: Hono, deps: ServerDeps): void {
  const { docStore, db } = deps;

  app.get('/api/docs/projects/:projectId/collections', (c) => {
    const projectId = parseIdParam(c, 'projectId');
    if (!Number.isFinite(projectId)) return c.json({ error: 'invalid project id' }, 400);
    if (!db.getProject(projectId)) return notFound(c, 'project not found');
    return c.json(docStore.listCollectionsForProject(projectId));
  });

  app.get('/api/docs/collections/:id/projects', (c) => {
    const collectionId = parseIdParam(c);
    if (!Number.isFinite(collectionId)) return c.json({ error: 'invalid collection id' }, 400);
    if (!docStore.getCollection(collectionId)) return notFound(c, 'collection not found');
    return c.json(docStore.listProjectsForCollection(collectionId));
  });

  app.put('/api/docs/collections/:id/projects/:projectId', async (c) => {
    const collectionId = parseIdParam(c);
    const projectId = parseIdParam(c, 'projectId');
    if (!Number.isFinite(collectionId) || !Number.isFinite(projectId)) {
      return c.json({ error: 'invalid id' }, 400);
    }
    if (!docStore.getCollection(collectionId)) return notFound(c, 'collection not found');
    if (!db.getProject(projectId)) return notFound(c, 'project not found');
    const body = await parseJsonBody<LinkBody>(c);
    const origin = body.origin === 'auto' ? 'auto' : 'manual';
    const created = docStore.linkProjectCollection(projectId, collectionId, origin);
    return c.json({ linked: true, created });
  });

  app.delete('/api/docs/collections/:id/projects/:projectId', (c) => {
    const collectionId = parseIdParam(c);
    const projectId = parseIdParam(c, 'projectId');
    if (!Number.isFinite(collectionId) || !Number.isFinite(projectId)) {
      return c.json({ error: 'invalid id' }, 400);
    }
    const removed = docStore.unlinkProjectCollection(projectId, collectionId);
    return c.json({ unlinked: removed });
  });
}
