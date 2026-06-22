import type { Hono } from 'hono';
import { buildGlobalWorkspace } from '@mcp/code-agent/core/virtual-workspace.js';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';
import { resolveProjectPath } from '../workspace/paths.js';
import { listDirFiltered, listFilesRecursive, searchFiles } from './project-files.js';

export function mountCoderProjectTreeRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/coder/projects/:pid/tree', async (c) => {
    const projectId = parseIdParam(c, 'pid');
    if (!Number.isFinite(projectId)) {
      return c.json({ error: 'Invalid project id' }, 400);
    }
    const project = deps.db.getProject(projectId);
    if (project?.is_synthetic) {
      const linked = deps.sessionStore.listUnionProjects(projectId);
      if (linked.length > 0) {
        buildGlobalWorkspace(
          project.root_path,
          linked.map((p) => ({ name: p.name, rootPath: p.root_path })),
        );
      }
    }
    const relPath = c.req.query('path') ?? '.';
    const query = c.req.query('q')?.trim() ?? '';
    const resolved = resolveProjectPath(deps, projectId, relPath);
    if (!resolved) {
      return c.json({ error: 'Project has no local path or path is outside the root' }, 400);
    }

    const recursive = c.req.query('recursive') === '1';

    try {
      if (recursive) {
        const { files, truncated } = await listFilesRecursive(resolved.root, relPath);
        return c.json({ mode: 'recursive', path: relPath, files, truncated });
      }
      if (query.length >= 2) {
        const { results, truncated } = await searchFiles(resolved.root, query);
        return c.json({ mode: 'search', query, entries: results, truncated });
      }
      const entries = await listDirFiltered(resolved.root, relPath);
      return c.json({ mode: 'tree', path: relPath, entries });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });
}
