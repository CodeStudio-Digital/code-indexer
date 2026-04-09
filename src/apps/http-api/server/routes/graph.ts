import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';

export function mountGraphRoutes(app: Hono, deps: ServerDeps): void {
  const { db } = deps;

  app.get('/api/projects/:id/dependencies', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const filePath = c.req.query('file');
    if (!filePath) return c.json({ error: 'file query param required' }, 400);
    const file = db.getFile(projectId, filePath);
    if (!file) return c.json({ error: 'File not found' }, 404);
    return c.json(db.getDependencies(file.id));
  });

  app.get('/api/projects/:id/dependents', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const filePath = c.req.query('file');
    if (!filePath) return c.json({ error: 'file query param required' }, 400);
    const file = db.getFile(projectId, filePath);
    if (!file) return c.json({ error: 'File not found' }, 404);
    return c.json(db.getDependents(projectId, file.id));
  });

  app.get('/api/projects/:id/circular-deps', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    return c.json(db.getCircularDeps(projectId));
  });

  app.get('/api/projects/:id/references', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const symbol = c.req.query('symbol');
    if (!symbol) return c.json({ error: 'symbol query param required' }, 400);
    return c.json(db.getSymbolCallers(projectId, symbol));
  });

  app.get('/api/projects/:id/hierarchy', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const symbol = c.req.query('symbol');
    if (!symbol) return c.json({ error: 'symbol query param required' }, 400);
    return c.json(db.getSymbolHierarchy(projectId, symbol));
  });

  app.get('/api/projects/:id/architecture', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    return c.json(db.getArchitectureOverview(projectId));
  });
}
