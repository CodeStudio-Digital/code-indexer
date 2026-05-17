import type { Hono } from 'hono';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseIntQuery, notFound } from './_helpers.js';

export function mountSearchRoutes(app: Hono, deps: ServerDeps): void {
  const { db, hybridSearch } = deps;

  app.get('/api/projects/:id/search', async (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);

    const query = c.req.query('q') ?? '';
    const mode = (c.req.query('mode') ?? project.search_mode ?? 'hybrid') as SearchMode;
    const type = (c.req.query('type') ?? 'all') as SearchType;
    const limit = parseIntQuery(c, 'limit', 20);

    const { results, diagnostics } = await hybridSearch.searchWithDiag(
      projectId, project.name, query, { mode, type, limit },
    );
    return c.json({ results, diagnostics });
  });

  app.get('/api/search', async (c) => {
    const query = c.req.query('q') ?? '';
    const limit = parseIntQuery(c, 'limit', 20);
    const projects = db.listProjects();
    const allResults = [];

    for (const p of projects) {
      const results = await hybridSearch.search(p.id, p.name, query, { limit });
      allResults.push(...results.map((r) => ({ ...r, project: p.name })));
    }

    allResults.sort((a, b) => b.score - a.score);
    return c.json(allResults.slice(0, limit));
  });
}
