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
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface LinkBody {
  origin?: 'manual' | 'auto';
}

export function mountDocsProjectLinkRoutes(app: HttpRouter, deps: ServerDeps): void {
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

  app.get('/api/docs/collections/:id/project-suggestions', (c) => {
    const collectionId = parseIdParam(c);
    const collection = docStore.getCollection(collectionId);
    if (!collection) return notFound(c, 'collection not found');
    const linked = new Set(docStore.listProjectsForCollection(collectionId).map((row) => row.project_id));
    const sources = docStore.listSourcesByCollection(collectionId);
    const corpusText = [collection.name, collection.description ?? '', ...sources.flatMap((s) => [s.title ?? '', s.uri])]
      .join(' ').toLowerCase();
    const corpusTokens = new Set(corpusText.split(/[^a-z0-9_.-]+/).filter((token) => token.length >= 4));
    const suggestions: Array<{ project_id: number; project_name: string; confidence: number; reason: string }> = [];
    for (const project of db.listProjects()) {
      if (linked.has(project.id)) continue;
      const unity = corpusText.includes('unity') || corpusText.includes('scriptreference');
      if (unity && existsSync(path.join(project.root_path, 'ProjectSettings', 'ProjectVersion.txt'))) {
        suggestions.push({ project_id: project.id, project_name: project.name, confidence: 0.98, reason: 'Unity ProjectVersion.txt detected' });
        continue;
      }
      const manifest = path.join(project.root_path, 'package.json');
      if (existsSync(manifest)) {
        try {
          const json = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const deps = Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) });
          const matched = deps.find((dep) => corpusTokens.has(dep.toLowerCase()) || corpusText.includes(dep.toLowerCase()));
          if (matched) {
            suggestions.push({ project_id: project.id, project_name: project.name, confidence: 0.9, reason: `dependency ${matched} detected` });
          }
        } catch { /* malformed manifests are ignored */ }
      }
    }
    return c.json(suggestions);
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
