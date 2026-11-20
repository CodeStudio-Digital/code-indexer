import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { createProjectWorktree } from '@mcp/code-agent/tools/worktree-operations.js';
import { listProjectWorktrees } from '../../worktree-reads.js';
import { requireTrustedLocalRequest } from '../../middleware/local-origin.js';
import { removeConfirmedWorktree, validRemoval, WorktreeRemovalError } from './remove-worktree.js';

export function mountCoderWorktreeRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.post('/api/coder/worktrees/remove', requireTrustedLocalRequest, async (c) => {
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'Expected a JSON confirmation' }, 415);
    }
    const body: unknown = await c.req.json().catch(() => null);
    if (!validRemoval(body)) return c.json({ error: 'A confirmed worktree selection and explicit removal options are required' }, 400);
    const owner = deps.db.getProjectCatalogEntry(body.project_id);
    if (!owner || owner.is_synthetic || owner.worktree_parent_id) return c.json({ error: 'Project not found' }, 404);
    try {
      return c.json(await removeConfirmedWorktree(deps, owner.root_path, body, c.req.raw.signal));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error),
        code: error instanceof WorktreeRemovalError ? error.code : undefined }, 409);
    }
  });

  app.post('/api/coder/worktrees/workspace', async (c) => {
    const body = await c.req.json<{ project_id?: number; worktree_path?: string }>();
    const projectId = body?.project_id;
    if (typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId <= 0 || typeof body.worktree_path !== 'string') {
      return c.json({ error: 'project_id and worktree_path are required' }, 400);
    }
    const owner = deps.db.getProjectCatalogEntry(projectId);
    if (!owner || owner.is_synthetic || owner.worktree_parent_id) return c.json({ error: 'Project not found' }, 404);
    try {
      const path = await deps.resolveProjectWorktree(owner.root_path, body.worktree_path, { signal: c.req.raw.signal });
      if (!path) return c.json({ error: 'Select a linked worktree' }, 400);
      c.req.raw.signal.throwIfAborted();
      const project = deps.db.getOrCreateWorktreeProject(owner.id, path);
      return c.json({ projectId: project.id, worktreePath: path });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.get('/api/coder/worktrees', async (c) => {
    const id = Number(c.req.query('project_id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'project_id required' }, 400);
    const project = deps.db.getProjectCatalogEntry(id);
    if (!project || project.is_synthetic || project.worktree_parent_id) return c.json({ error: 'Project not found' }, 404);
    try {
      return c.json({ ...await listProjectWorktrees(project.root_path, { signal: c.req.raw.signal }), projectId: id });
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
    const project = deps.db.getProjectCatalogEntry(body.project_id);
    if (!project || project.is_synthetic || project.worktree_parent_id) return c.json({ error: 'Project not found' }, 404);
    const result = await createProjectWorktree(project.root_path, { name: body.name, branch: body.branch });
    if (!result.ok) return c.json(result, result.outcomeUnknown ? 409 : 400);
    return c.json(result, 201);
  });
}
