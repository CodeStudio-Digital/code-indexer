import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';

export function mountFilesRoutes(app: Hono, deps: ServerDeps): void {
  const { db } = deps;

  app.get('/api/projects/:id/files', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    return c.json(db.listFiles(projectId));
  });

  app.get('/api/projects/:id/files/*', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const filePath = c.req.path.replace(`/api/projects/${c.req.param('id')}/files/`, '');
    const file = db.getFile(projectId, filePath);
    if (!file) return c.json({ error: 'Not found' }, 404);
    const symbols = db.getSymbolsByFile(projectId, filePath);
    const dependencies = db.getDependencies(file.id);
    const dependents = db.getDependents(projectId, file.id);
    return c.json({ ...file, symbols, dependencies, dependents });
  });

  app.get('/api/symbols/:id', (c) => {
    const sym = db.getSymbolById(parseInt(c.req.param('id'), 10));
    if (!sym) return c.json({ error: 'Not found' }, 404);
    return c.json(sym);
  });

  app.get('/api/symbols/:id/members', (c) => {
    const sym = db.getSymbolById(parseInt(c.req.param('id'), 10));
    if (!sym) return c.json({ error: 'Not found' }, 404);
    const members = db.getClassMembers(sym.name, sym.project_id);
    return c.json(members);
  });

  app.get('/api/projects/:id/concepts', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    return c.json(db.listConcepts(projectId));
  });

  app.get('/api/projects/:id/concepts/:concept', (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    return c.json(db.getFilesByConcept(projectId, c.req.param('concept')));
  });
}
