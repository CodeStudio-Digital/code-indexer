import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import { createFilesHandlers, createContext, resolveSafe } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';
import { createMediaFileResponse, createProjectPreviewResponse } from './media-file-response.js';

/**
 * HttpRouter adapters for /api/projects/:id/files/* and /api/symbols/*.
 *
 * Read/write/tree (new for the IDE workspace) and the legacy listing
 * routes all share the same handler in @mcp/api-handlers/files.
 */
function mapApiError(c: HttpContext, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountFilesRoutes(app: HttpRouter, deps: ServerDeps): void {
  const h = createFilesHandlers(deps);
  const touchIndexedFile = (projectId: number, filePath: string, kind: 'view' | 'edit'): void => {
    try {
      const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
      // Recency is path-addressable until hybrid search actually consumes it.
      // Opening/saving an editor tab must not synchronously open + bootstrap a
      // cold per-project SQLite handle merely to obtain an optional ranking id.
      deps.recentFilesSource.touch({
        projectId,
        fileId: null,
        filePath: normalized,
        kind,
      });
    } catch {
      // Recency is an optional ranking signal; it must never break editor I/O.
    }
  };

  app.get('/api/projects/:id/files', async (c) => {
    try {
      return c.json(await h.list({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/file-paths', async (c) => {
    try {
      const search = c.req.query('format') === 'page' ? h.searchPathsPage : h.searchPaths;
      return c.json(await search({
        projectId: parseIdParam(c), query: c.req.query('query') ?? '',
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        fuzzy: c.req.query('fuzzy') !== 'false',
      }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/manifest', async (c) => {
    try {
      return c.json(await h.manifest({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  /**
   * Workspace file tree — recursive directory listing for the IDE
   * FileTreeRail. Optional `maxDepth` (default 6) and `root` (default '.').
   * NEW endpoint added by the IDE refactor; the legacy `/files` listing
   * (above) returns indexed-files metadata from SQLite, which is a
   * different concept.
   */
  app.get('/api/projects/:id/file-tree', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const maxDepth = c.req.query('maxDepth') ? Number(c.req.query('maxDepth')) : undefined;
      const root = c.req.query('root') ?? undefined;
      const withStats = c.req.query('withStats') === '1';
      return c.json(await h.tree({ projectId, maxDepth, root, withStats }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /**
   * Raw file read — for the Monaco editor's "Open file" path.
   * Body-less GET; path goes in the query so wildcard routes don't
   * collide with the legacy `/files/*` listing.
   */
  app.get('/api/projects/:id/file', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const filePath = c.req.query('path');
      if (!filePath) return c.json({ error: 'path query param required' }, 400);
      const ifModifiedSince = c.req.query('ifModifiedSince') || undefined;
      const result = await h.read({ projectId, path: filePath, ifModifiedSince }, createContext());
      touchIndexedFile(projectId, filePath, 'view');
      return c.json(result);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /**
   * Binary/streaming read for editor previews. Unlike `files.read`, this keeps
   * bytes intact and honors Range requests used by native audio/video controls.
   */
  app.get('/api/projects/:id/file/raw', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const filePath = c.req.query('path');
      if (!filePath) return c.json({ error: 'path query param required' }, 400);
      const project = deps.db.getProject(projectId);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      const absolutePath = resolveSafe(project.root_path, filePath);
      const response = await createMediaFileResponse(absolutePath, c.req.header('range'));
      touchIndexedFile(projectId, filePath, 'view');
      return response;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return notFound(c);
      return mapApiError(c, err);
    }
  });

  /**
   * Path-based project preview. Keeping the file path in the URL lets HTML
   * pages navigate to sibling documents and load relative styles/media/fonts.
   */
  app.get('/api/projects/:id/preview/*', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const filePath = c.req.param('*')?.replace(/^\/+/, '');
      if (!filePath) return c.json({ error: 'preview file path required' }, 400);
      const project = deps.db.getProject(projectId);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      const absolutePath = resolveSafe(project.root_path, filePath);
      const normalized = filePath.replace(/\\/g, '/');
      const slash = normalized.lastIndexOf('/');
      const directory = slash >= 0 ? normalized.slice(0, slash + 1) : '';
      const encodePath = (value: string) => value
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const previewRoot = `/api/projects/${projectId}/preview/`;
      const baseHref = `${previewRoot}${encodePath(directory)}${directory ? '/' : ''}`;
      const response = await createProjectPreviewResponse(
        absolutePath,
        baseHref,
        previewRoot,
        c.req.header('range'),
      );
      touchIndexedFile(projectId, filePath, 'view');
      return response;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return notFound(c);
      return mapApiError(c, err);
    }
  });

  /**
   * Write file (Ctrl+S in the editor). Body: `{ path, content, encoding? }`.
   */
  app.put('/api/projects/:id/file', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>();
      if (!body.path) return c.json({ error: 'path required' }, 400);
      const result = await h.write({ projectId, ...body }, createContext());
      touchIndexedFile(projectId, body.path, 'edit');
      return c.json(result);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /**
   * Delete file or empty directory. Pass `recursive=1` to delete a
   * non-empty directory.
   */
  app.delete('/api/projects/:id/file', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const filePath = c.req.query('path');
      const recursive = c.req.query('recursive') === '1';
      if (!filePath) return c.json({ error: 'path query param required' }, 400);
      return c.json(await h.delete({ projectId, path: filePath, recursive }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /** Rename / move file or directory. Body: `{ from, to }`. */
  app.post('/api/projects/:id/file/rename', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{ from: string; to: string }>();
      if (!body.from || !body.to) return c.json({ error: 'from + to required' }, 400);
      return c.json(await h.rename({ projectId, from: body.from, to: body.to }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /** Create directory (recursive). Body: `{ path }`. */
  app.post('/api/projects/:id/dir', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{ path: string }>();
      if (!body.path) return c.json({ error: 'path required' }, 400);
      return c.json(await h.mkdir({ projectId, path: body.path }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /** Zip files/folders into a project-relative `.zip`. Body: `{ paths, out }`. */
  app.post('/api/projects/:id/archive', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{ paths: string[]; out: string }>();
      if (!body.paths?.length || !body.out) return c.json({ error: 'paths + out required' }, 400);
      return c.json(await h.archive({ projectId, paths: body.paths, out: body.out }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /** Extract a project-relative zip into `dest`. Body: `{ zip, dest }`. */
  app.post('/api/projects/:id/extract', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{ zip: string; dest: string }>();
      if (!body.zip || !body.dest) return c.json({ error: 'zip + dest required' }, 400);
      return c.json(await h.extract({ projectId, zip: body.zip, dest: body.dest }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // ── Local History (mig 160) ──────────────────────────────────────
  // Registradas ANTES do wildcard `/files/*` abaixo (mesmo cuidado de ordenação).
  app.get('/api/projects/:id/file/history', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const filePath = c.req.query('path');
      if (!filePath) return c.json({ error: 'path query param required' }, 400);
      return c.json(await h.historyList({ projectId, path: filePath }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/file/history/:revId', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const id = Number(c.req.param('revId'));
      return c.json(await h.historyGet({ projectId, id }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/file/history/:revId/restore', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const id = Number(c.req.param('revId'));
      return c.json(await h.historyRestore({ projectId, id }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/file/history/:revId/label', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const id = Number(c.req.param('revId'));
      const body = await c.req.json<{ label: string }>();
      if (!body.label) return c.json({ error: 'label required' }, 400);
      return c.json(await h.historyLabel({ projectId, id, label: body.label }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  // Legacy detail endpoint — kept for backwards compat with the dashboard's
  // FileViewer. The wildcard route MUST be registered AFTER `/file-tree`
  // and `/file` above so HttpRouter doesn't capture them as wildcard paths.
  app.get('/api/projects/:id/files/*', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const filePath = c.req.path.replace(`/api/projects/${c.req.param('id')}/files/`, '');
      const result = await h.get({ projectId, path: filePath }, createContext());
      touchIndexedFile(projectId, filePath, 'view');
      return c.json(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.get('/api/symbols/:id', async (c) => {
    try {
      // Optional ?projectId routes the surrogate-id lookup to that project's DB
      // (post-split the id is unique only there); absent → central, as before.
      const pid = c.req.query('projectId');
      const projectId = pid ? Number(pid) : undefined;
      return c.json(await h.symbol({ id: parseIdParam(c), projectId }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.get('/api/symbols/:id/members', async (c) => {
    try {
      const pid = c.req.query('projectId');
      const projectId = pid ? Number(pid) : undefined;
      return c.json(await h.symbolMembers({ id: parseIdParam(c), projectId }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

}
