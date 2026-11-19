import { realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { Context, Hono } from 'hono';
import { resolveSafe, resolveWorkspacePath, type WorkspacePathContext } from '@mcp/code-agent/tools/paths.js';
import { resolveSessionProjectAuthority } from '@mcp/session-storage/fs-store/index.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';
import type { ServerDeps } from '../../deps.js';
import { resolveProjectWorktree } from '../../worktree-reads.js';
import { parseIdParam, parseSessionIdParam } from '../_helpers.js';
import { readText } from '../workspace/file-service.js';

const imageTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

/** Resolve message links in the same checkout and project namespace as the agent. */
export function mountCoderLinkedFileRoute(app: Hono, { db, sessionStore }: ServerDeps): void {
  app.get('/api/projects/:id/linked-file', c => {
    const project = db.getProjectCatalogEntry(parseIdParam(c));
    if (!project || project.is_synthetic || !project.root_path.trim()) return c.json({ error: 'workspace' }, 404);
    return readLinkedFile(c, { cwd: project.root_path, projectName: project.name, projectId: project.id }, null);
  });
  app.get('/api/coder/sessions/:id/linked-file', async c => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (!session) return c.json({ error: 'workspace' }, 404);
    const authority = resolveSessionProjectAuthority(session, projectId => {
      const p = db.getProjectCatalogEntry(projectId);
      return p && !p.is_synthetic ? { project_id: p.id, name: p.name, root_path: p.root_path } : null;
    });
    if (!authority) return c.json({ error: 'workspace' }, 409);
    const { primary } = authority;
    let worktree: string | null = null;
    if (session.worktree_path) {
      try { worktree = await resolveProjectWorktree(primary.root_path, session.worktree_path, { signal: c.req.raw.signal }); }
      catch { return c.json({ error: 'workspace' }, 409); }
    }
    const cwd = worktree ?? primary.root_path;
    const projects = session.is_global ? assignWorkspaceSlugs(authority.projects).map(p => ({
      projectId: p.project_id, name: p.name, slug: p.slug, isPrimary: p.is_primary,
      rootPath: p.is_primary ? cwd : p.root_path,
    })) : undefined;
    const roots = await sessionStore.listSessionFilesystemRoots(id);
    return readLinkedFile(c, {
      cwd, projectName: primary.name, projectId: primary.project_id,
      globalWorkspace: projects && { projects },
      externalRoots: roots.map(r => ({ id: r.id, rootPath: r.root_path, access: r.access })),
    }, worktree);
  });
}

async function readLinkedFile(c: Context, context: WorkspacePathContext, worktree: string | null) {
  const path = c.req.query('path')?.replace(/\\/g, '/');
  if (!path || path.length > 32768 || path.startsWith('//') || /[\x00-\x1f]/.test(path)
    || (process.platform === 'win32' && path.replace(/^[a-z]:\//i, '').includes(':'))) {
    return c.json({ error: 'invalid' }, 400);
  }
  const target = resolveWorkspacePath(path, context, 'read');
  if (!target.ok) return c.json({ error: 'outside' }, 403);
  try {
    const [root, file] = await Promise.all([realpath(target.rootPath), realpath(target.abs)]);
    if (!resolveSafe(file, root)) return c.json({ error: 'outside' }, 403);
    if (!(await stat(file)).isFile()) return c.json({ error: 'notFile' }, 422);
    const data = await readText(file);
    const imageType = data.isBinary && !data.truncated ? imageTypes[extname(file).toLowerCase()] : undefined;
    c.header('Cache-Control', 'no-store');
    return c.json({
      path: target.relativePath, absolutePath: resolve(target.abs).replace(/\\/g, '/'),
      projectId: target.projectId ?? null, worktreePath: target.projectId === context.projectId ? worktree : null,
      content: data.isBinary && !imageType ? '' : data.content, imageType, size: data.size,
      truncated: data.truncated, isBinary: data.isBinary,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return c.json({ error: 'missing' }, 404);
    if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'denied' }, 403);
    return c.json({ error: 'unreadable' }, 500);
  }
}
