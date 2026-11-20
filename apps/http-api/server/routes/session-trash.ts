import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import {
  SessionRootUnavailableError,
  UnsafeSessionPathError,
  type SessionMetadata,
  type SessionStorageScope,
} from '@mcp/session-storage';
import type { ServerDeps } from '../deps.js';

type SessionTrashDeps = Pick<ServerDeps, 'sessionStore'>;

class TrashRequestError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

function parseScope(c: HttpContext): SessionStorageScope {
  const kind = c.req.query('scope');
  const rawProjectId = c.req.query('project_id');
  if (kind === 'global' && rawProjectId === undefined) {
    return { kind: 'global' };
  }
  if (kind === 'project' && rawProjectId !== undefined) {
    if (!/^[1-9]\d*$/.test(rawProjectId)) {
      throw new TrashRequestError(400, 'project_id must be a positive integer');
    }
    const projectId = Number(rawProjectId);
    if (!Number.isSafeInteger(projectId)) {
      throw new TrashRequestError(400, 'project_id must be a safe integer');
    }
    return { kind: 'project', project_id: projectId };
  }
  throw new TrashRequestError(
    400,
    'scope must be global, or project with a numeric project_id',
  );
}

function metadataSummary(metadata: SessionMetadata) {
  return {
    id: metadata.id,
    kind: metadata.kind,
    title: metadata.title,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function trashErrorResponse(c: HttpContext, error: unknown, operation: 'list' | 'item'): Response {
  if (error instanceof TrashRequestError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof SessionRootUnavailableError) {
    return c.json({ error: error.message }, 404);
  }
  if (isMissing(error)) {
    return c.json({ error: 'trash bundle not found' }, 404);
  }
  if (error instanceof UnsafeSessionPathError) {
    return operation === 'item'
      ? c.json({ error: 'invalid or unsafe trash_name' }, 400)
      : c.json({ error: 'trash storage failed safety validation' }, 409);
  }
  const message = (error as Error)?.message ?? '';
  if (message.includes('destination already exists')) {
    return c.json({ error: 'session destination already exists' }, 409);
  }
  throw error;
}

/**
 * Generic filesystem-session trash surface. Scope is mandatory so a token
 * can never be searched across project roots or silently fall back to global.
 *
 * GET  /api/sessions/trash?scope=global
 * GET  /api/sessions/trash?scope=project&project_id=7
 * POST /api/sessions/trash/:trashName/restore?...scope...
 * POST /api/sessions/trash/:trashName/purge?...scope...
 */
export function mountSessionTrashRoutes(app: HttpRouter, deps: SessionTrashDeps): void {
  app.get('/api/sessions/trash', async (c) => {
    try {
      const scope = parseScope(c);
      const entries = await deps.sessionStore.listTrashedSessions(scope);
      return c.json({
        scope,
        items: entries.map((entry) => ({
          trash_name: entry.trash_name,
          trashed_at: entry.trashed_at,
          scope: entry.scope,
          metadata: metadataSummary(entry.metadata),
        })),
      });
    } catch (error) {
      return trashErrorResponse(c, error, 'list');
    }
  });

  app.post('/api/sessions/trash/:trashName/restore', async (c) => {
    try {
      const scope = parseScope(c);
      const trashName = c.req.param('trashName');
      const trashed = await deps.sessionStore.getTrashedSession(scope, trashName);
      const restored = await deps.sessionStore.restoreTrashedSession(scope, trashName);
      return c.json({
        ok: true,
        trash_name: trashName,
        trashed_at: trashed.trashed_at,
        scope,
        metadata: metadataSummary(restored.session),
      });
    } catch (error) {
      return trashErrorResponse(c, error, 'item');
    }
  });

  app.post('/api/sessions/trash/:trashName/purge', async (c) => {
    try {
      const scope = parseScope(c);
      const trashName = c.req.param('trashName');
      const trashed = await deps.sessionStore.getTrashedSession(scope, trashName);
      await deps.sessionStore.purgeTrashedSession(scope, trashName);
      return c.json({
        ok: true,
        trash_name: trashName,
        trashed_at: trashed.trashed_at,
        scope,
        metadata: metadataSummary(trashed.metadata),
      });
    } catch (error) {
      return trashErrorResponse(c, error, 'item');
    }
  });
}
