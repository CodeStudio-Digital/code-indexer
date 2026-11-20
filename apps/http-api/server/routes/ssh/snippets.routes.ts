import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { snippetInProject } from './_ownership.js';
import type { SshSnippetPatch } from '@mcp/store/ssh-store-types.js';

/** CRUD for saved SSH snippets (migration 173) — commands runnable on a host. */
export function mountSshSnippetRoutes(app: HttpRouter, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/ssh';

  app.get(`${base}/snippets`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    return c.json({ snippets: deps.sshStoreFor(projectId).listSnippets(projectId) });
  });

  app.post(`${base}/snippets`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const body = await parseJsonBody<{ name: string; command: string }>(c);
    if (!body.name?.trim() || !body.command?.trim()) {
      return c.json({ error: 'name and command are required' }, 400);
    }
    return c.json(store.createSnippet({ project_id: projectId, name: body.name.trim(), command: body.command }));
  });

  app.patch(`${base}/snippets/:sid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const sid = parseIdParam(c, 'sid');
    if (!snippetInProject(store, projectId, sid)) return notFound(c, `Snippet ${sid} not found`);
    store.updateSnippet(sid, await parseJsonBody<SshSnippetPatch>(c));
    return c.json(store.getSnippet(sid));
  });

  app.delete(`${base}/snippets/:sid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const sid = parseIdParam(c, 'sid');
    if (!snippetInProject(store, projectId, sid)) return notFound(c, `Snippet ${sid} not found`);
    store.deleteSnippet(sid);
    return c.json({ ok: true });
  });
}
