import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';

export function mountGraphRoutes(app: Hono, deps: ServerDeps): void {
  const { db } = deps;

  app.get('/api/projects/:id/dependencies', (c) => {
    const projectId = parseIdParam(c);
    const filePath = c.req.query('file');
    if (!filePath) return c.json({ error: 'file query param required' }, 400);
    const file = db.getFile(projectId, filePath);
    if (!file) return notFound(c, 'File not found');
    return c.json(db.getDependencies(file.id, projectId));
  });

  app.get('/api/projects/:id/dependents', (c) => {
    const projectId = parseIdParam(c);
    const filePath = c.req.query('file');
    if (!filePath) return c.json({ error: 'file query param required' }, 400);
    const file = db.getFile(projectId, filePath);
    if (!file) return notFound(c, 'File not found');
    return c.json(db.getDependents(projectId, file.id));
  });

  app.get('/api/projects/:id/circular-deps', (c) => {
    return c.json(db.getCircularDeps(parseIdParam(c)));
  });

  app.get('/api/projects/:id/references', (c) => {
    const projectId = parseIdParam(c);
    const symbol = c.req.query('symbol');
    if (!symbol) return c.json({ error: 'symbol query param required' }, 400);
    return c.json(db.getSymbolCallers(projectId, symbol));
  });

  app.get('/api/projects/:id/hierarchy', (c) => {
    const projectId = parseIdParam(c);
    const symbol = c.req.query('symbol');
    if (!symbol) return c.json({ error: 'symbol query param required' }, 400);
    return c.json(db.getSymbolHierarchy(projectId, symbol));
  });
}
