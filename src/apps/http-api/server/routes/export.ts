import type { Hono } from 'hono';
import type { ExportSection } from '../../../../types.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';

interface ExportBody {
  format?: string;
  sections?: string[];
  outputPath?: string;
}

export function mountExportRoutes(app: Hono, deps: ServerDeps): void {
  const { db, exportService } = deps;

  app.post('/api/projects/:id/export', async (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);

    const body = await parseJsonBody<ExportBody>(c);
    const output = exportService.export({
      projectId,
      projectName: project.name,
      format: (body.format ?? 'markdown') as 'markdown' | 'json',
      sections: (body.sections ?? []) as ExportSection[],
      outputPath: body.outputPath,
      includeSnapshots: true,
      includeCosts: true,
    });

    return c.text(output);
  });
}
