import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';

interface CreateGroupBody {
  project_id: number;
  name: string;
  color?: string | null;
}

interface UpdateGroupBody {
  name?: string;
  color?: string | null;
  sort_order?: number;
}

/**
 * CRUD routes for coder_session_groups (migration 009). Groups are per-project
 * folders used by the dashboard sidebar to organize chat sessions.
 */
export function mountCoderGroupsRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore } = deps;

  app.get('/api/coder/groups', (c) => {
    const projectId = parseInt(c.req.query('project_id') ?? '0', 10);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);
    return c.json(sessionStore.listGroups(projectId));
  });

  app.post('/api/coder/groups', async (c) => {
    const body = await c.req.json<CreateGroupBody>().catch(() => ({}) as CreateGroupBody);
    if (!body.project_id || !body.name) {
      return c.json({ error: 'project_id and name required' }, 400);
    }
    const group = sessionStore.createGroup({
      project_id: body.project_id,
      name: body.name.trim(),
      color: body.color ?? null,
    });
    return c.json(group, 201);
  });

  app.patch('/api/coder/groups/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<UpdateGroupBody>().catch(() => ({}) as UpdateGroupBody);
    const updated = sessionStore.updateGroup(id, body);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  });

  app.delete('/api/coder/groups/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    sessionStore.deleteGroup(id);
    return c.json({ ok: true });
  });
}
