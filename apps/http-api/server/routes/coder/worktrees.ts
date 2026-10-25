import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { createProjectWorktree } from '@mcp/code-agent/tools/worktree-operations.js';
import { listProjectWorktrees } from '@mcp/code-agent/tools/project-worktrees.js';

export function mountCoderWorktreeRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/coder/worktrees', async (c) => {
    const id = Number(c.req.query('project_id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'project_id required' }, 400);
    const project = deps.db.getProject(id);
    if (!project || project.is_synthetic) return c.json({ error: 'Project not found' }, 404);
    try {
      return c.json({ ...await listProjectWorktrees(project.root_path), projectId: id });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post('/api/coder/worktrees', async (c) => {
    const body = await c.req.json<{ project_id: number; name?: string; branch?: string }>();
    if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.project_id) || body.project_id <= 0
      || (body.name !== undefined && typeof body.name !== 'string')
      || (body.branch !== undefined && typeof body.branch !== 'string')) {
      return c.json({ error: 'Invalid project_id, name or branch' }, 400);
    }
    const project = deps.db.getProject(body.project_id);
    if (!project || project.is_synthetic) return c.json({ error: 'Project not found' }, 404);
    const result = await createProjectWorktree(project.root_path, { name: body.name, branch: body.branch });
    if (!result.ok) return c.json(result, result.outcomeUnknown ? 409 : 400);
    return c.json(result, 201);
  });
}
