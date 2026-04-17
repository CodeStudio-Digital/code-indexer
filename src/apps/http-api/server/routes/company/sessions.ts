import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';

interface CreateSessionBody {
  template_id?: number;
  name: string;
  project_ids: number[];
  project_labels?: Record<number, string>;
  master_provider: string;
  master_model: string;
  role_assignments?: Array<{
    role: string;
    provider: string;
    model: string;
    project_ids: number[];
    tier?: string;
  }>;
}

export function mountCompanySessionRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  app.get('/api/company/sessions', (c) => {
    const status = c.req.query('status') as 'idle' | 'running' | 'completed' | undefined;
    return c.json(companyStore.listCompanySessions(status ? { status } : undefined));
  });

  app.get('/api/company/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const full = companyStore.getCompanySessionFull(id);
    if (!full) return notFound(c);

    // Enrich projects with names
    const enrichedProjects = full.projects.map((p) => {
      const proj = db.getProject(p.project_id);
      return {
        ...p,
        project_name: proj?.name ?? `project-${p.project_id}`,
        root_path: proj?.root_path ?? '',
      };
    });

    return c.json({
      ...full,
      projects: enrichedProjects,
    });
  });

  app.post('/api/company/sessions', async (c) => {
    const body = await parseJsonBody<CreateSessionBody>(c);
    if (!body.name || !body.project_ids?.length) {
      return c.json({ error: 'name and project_ids required' }, 400);
    }

    // Validate all projects exist
    for (const pid of body.project_ids) {
      const proj = db.getProject(pid);
      if (!proj) return c.json({ error: `Project ${pid} not found` }, 404);
    }

    // Create company session
    const session = companyStore.createCompanySession({
      template_id: body.template_id,
      name: body.name.trim(),
      config_json: JSON.stringify({
        master_provider: body.master_provider,
        master_model: body.master_model,
        role_assignments: body.role_assignments ?? [],
      }),
    });

    // Link projects
    for (const pid of body.project_ids) {
      companyStore.addProjectToCompanySession(
        session.id,
        pid,
        body.project_labels?.[pid],
      );
    }

    return c.json(companyStore.getCompanySessionFull(session.id), 201);
  });

  app.delete('/api/company/sessions/:id', (c) => {
    const deleted = companyStore.deleteCompanySession(parseIdParam(c));
    if (!deleted) return notFound(c);
    return c.json({ ok: true });
  });
}
