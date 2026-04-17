import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseIntQuery, parseJsonBody, notFound } from '../_helpers.js';

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
    const projectId = parseIntQuery(c, 'project_id', 0);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);
    return c.json(sessionStore.listGroups(projectId));
  });

  app.post('/api/coder/groups', async (c) => {
    const body = await parseJsonBody<CreateGroupBody>(c);
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
    const id = parseIdParam(c);
    const body = await parseJsonBody<UpdateGroupBody>(c);
    const updated = sessionStore.updateGroup(id, body);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  app.delete('/api/coder/groups/:id', (c) => {
    sessionStore.deleteGroup(parseIdParam(c));
    return c.json({ ok: true });
  });
}
