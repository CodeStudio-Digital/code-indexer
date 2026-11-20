import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import {
  notFound,
  parseIntQuery,
  parseJsonBody,
  parseSessionRecordIdParam,
} from '../_helpers.js';

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
 * Filesystem-backed session folders used by the dashboard sidebar.
 *
 * Groups live beside the project session bundles under the project's
 * `.mcp-indexer/session/groups` namespace. Their public ids are UUIDs; the
 * numeric project id is only the essential catalog key used to locate the
 * project root.
 */
export function mountCoderGroupsRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { sessionStore } = deps;

  app.get('/api/coder/groups', async (c) => {
    const projectId = parseIntQuery(c, 'project_id', 0);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);
    return c.json(await sessionStore.listGroups(projectId));
  });

  app.post('/api/coder/groups', async (c) => {
    const body = await parseJsonBody<CreateGroupBody>(c);
    if (!body.project_id || !body.name) {
      return c.json({ error: 'project_id and name required' }, 400);
    }
    const group = await sessionStore.createGroup(body.project_id, {
      name: body.name.trim(),
      color: body.color ?? null,
    });
    return c.json(group, 201);
  });

  app.patch('/api/coder/groups/:id', async (c) => {
    const projectId = parseIntQuery(c, 'project_id', 0);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);
    const id = parseSessionRecordIdParam(c, 'id');
    const body = await parseJsonBody<UpdateGroupBody>(c);
    const updated = await sessionStore.updateGroup(projectId, id, body);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  app.delete('/api/coder/groups/:id', async (c) => {
    const projectId = parseIntQuery(c, 'project_id', 0);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);
    const deleted = await sessionStore.deleteGroup(
      projectId,
      parseSessionRecordIdParam(c, 'id'),
    );
    if (!deleted) return notFound(c);
    return c.json({ ok: true });
  });
}
