import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { notFound, parseCompanySessionIdParam, parseJsonBody, resolveCompanySessionContext } from '../_helpers.js';
import { withSessionLock } from '../coder/sessionLock.js';
import { notifyCompanySettingsChanged } from '../../../sse/workerPoolSingleton.js';
import { appOwnedControlPlaneConflict } from './runtime-capabilities.js';
import { removeServiceAndProject } from './service-helpers.js';

export function linkedProjectService(projectId: number, projectIds: number[], labels: Record<string, string | null>, services: ReadonlySet<string>) {
  const label = labels[String(projectId)];
  if (!label || !services.has(label)) return null;
  return projectIds.filter(id => labels[String(id)] === label).length === 1 ? label : null;
}

export function mountCompanyProjectRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.post('/api/company/sessions/:id/projects', async c => {
    const id = parseCompanySessionIdParam(c);
    const { project_id: projectId, label } = await parseJsonBody<{ project_id: number; label?: string }>(c);
    if (typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId < 1 || (label != null && typeof label !== 'string')) {
      return c.json({ error: 'Expected a positive integer project_id and an optional project label.' }, 400);
    }
    return withSessionLock(id, async () => {
      const ctx = await resolveCompanySessionContext(deps.sessionStore, id);
      if (!ctx) return notFound(c);
      if (ctx.root.runtime_kind === 'app_studio') return appOwnedControlPlaneConflict(c, 'project links');
      const project = deps.db.getProject(projectId);
      if (!project) return notFound(c, 'Project not found');
      if (ctx.requested.project_ids.includes(projectId)) return c.json({ error: 'Project already linked' }, 409);
      if (label && (Object.values(ctx.requested.project_labels).includes(label) || deps.companySandboxServicesStore.get(ctx.rootId, label))) {
        return c.json({ error: 'This label already identifies another project or service.' }, 409);
      }
      await ctx.requestedFiles.addLinkedProject({ projectId, rootPath: project.root_path, label });
      return c.json({ ok: true, receipt: notifyCompanySettingsChanged(id, ['projects']) });
    });
  });

  app.delete('/api/company/sessions/:id/projects/:projectId', async c => {
    const id = parseCompanySessionIdParam(c);
    const projectId = Number(c.req.param('projectId'));
    if (!Number.isSafeInteger(projectId) || projectId < 1) return c.json({ error: 'Invalid project id' }, 400);
    return withSessionLock(id, async () => {
      const ctx = await resolveCompanySessionContext(deps.sessionStore, id);
      if (!ctx) return notFound(c);
      if (ctx.root.runtime_kind === 'app_studio') return appOwnedControlPlaneConflict(c, 'project links');
      if (!ctx.requested.project_ids.includes(projectId)) return notFound(c, 'Project is not linked');
      const owner = deps.sessionStore.repository.readSessionSync(ctx.requestedFiles.location).owner_project_id;
      if (owner === projectId || ctx.requested.project_ids.length <= 1) {
        return c.json({ error: 'The project that owns the session history must stay linked.' }, 409);
      }
      // A child can inherit a label, and ordinary projects can have labels too.
      // Only a service owned by this root may be torn down from its project row.
      const label = ctx.requested.project_labels[String(projectId)];
      if (ctx.rootId === id && label && deps.companySandboxServicesStore.get(id, label)) {
        const service = linkedProjectService(projectId, ctx.root.project_ids, ctx.root.project_labels, new Set([label]));
        if (service) await removeServiceAndProject(deps, id, service);
      }
      if (ctx.requestedFiles.getSession().project_ids.includes(projectId)) await ctx.requestedFiles.removeLinkedProject(projectId);
      return c.json({ ok: true, receipt: notifyCompanySettingsChanged(id, ['projects']) });
    });
  });
}
