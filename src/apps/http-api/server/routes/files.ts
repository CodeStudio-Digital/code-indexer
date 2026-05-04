import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';
import { detectManifest } from '../../../../core/sandbox/manifest-detector/detect.js';
import { detectDockerfile } from '../../../../core/sandbox/dockerfile-detector.js';

export function mountFilesRoutes(app: Hono, deps: ServerDeps): void {
  const { db } = deps;

  app.get('/api/projects/:id/files', (c) => {
    return c.json(db.listFiles(parseIdParam(c)));
  });

  app.get('/api/projects/:id/manifest', (c) => {
    const project = db.getProject(parseIdParam(c));
    if (!project) return notFound(c);
    return c.json({
      manifest: detectManifest(project.root_path),
      dockerfile: detectDockerfile(project.root_path),
    });
  });

  app.get('/api/projects/:id/files/*', (c) => {
    const projectId = parseIdParam(c);
    const filePath = c.req.path.replace(`/api/projects/${c.req.param('id')}/files/`, '');
    const file = db.getFile(projectId, filePath);
    if (!file) return notFound(c);
    const symbols = db.getSymbolsByFile(projectId, filePath);
    const dependencies = db.getDependencies(file.id);
    const dependents = db.getDependents(projectId, file.id);
    return c.json({ ...file, symbols, dependencies, dependents });
  });

  app.get('/api/symbols/:id', (c) => {
    const sym = db.getSymbolById(parseIdParam(c));
    if (!sym) return notFound(c);
    return c.json(sym);
  });

  app.get('/api/symbols/:id/members', (c) => {
    const sym = db.getSymbolById(parseIdParam(c));
    if (!sym) return notFound(c);
    const members = db.getClassMembers(sym.name, sym.project_id);
    return c.json(members);
  });

  app.get('/api/projects/:id/concepts', (c) => {
    return c.json(db.listConcepts(parseIdParam(c)));
  });

  app.get('/api/projects/:id/concepts/:concept', (c) => {
    return c.json(db.getFilesByConcept(parseIdParam(c), c.req.param('concept')));
  });
}
