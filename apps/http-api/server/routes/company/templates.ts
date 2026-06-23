import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import type { CompanyRoleConfig } from '@mcp/company/types.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';

interface CreateTemplateBody {
  name: string;
  description?: string;
  roles: CompanyRoleConfig[];
}

interface UpdateTemplateBody {
  name?: string;
  description?: string;
  roles?: CompanyRoleConfig[];
}

export function mountCompanyTemplateRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.get('/api/company/templates', (c) => {
    return c.json(companyStore.listTemplates());
  });

  app.get('/api/company/templates/:id', (c) => {
    const template = companyStore.getTemplate(parseIdParam(c));
    if (!template) return notFound(c);
    return c.json(template);
  });

  app.post('/api/company/templates', async (c) => {
    const body = await parseJsonBody<CreateTemplateBody>(c);
    if (!body.name || !body.roles?.length) {
      return c.json({ error: 'name and roles required' }, 400);
    }
    // Validate at least one master role
    if (!body.roles.some((r) => r.role === 'master')) {
      return c.json({ error: 'At least one role must be "master"' }, 400);
    }
    const template = companyStore.createTemplate(
      body.name.trim(),
      body.description?.trim() ?? '',
      body.roles,
    );
    return c.json(template, 201);
  });

  app.patch('/api/company/templates/:id', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<UpdateTemplateBody>(c);
    const updated = companyStore.updateTemplate(id, body);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  app.delete('/api/company/templates/:id', (c) => {
    const deleted = companyStore.deleteTemplate(parseIdParam(c));
    if (!deleted) return notFound(c);
    return c.json({ ok: true });
  });
}
