import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Hono } from 'hono';
import type { SessionFilesystemAccess } from '@mcp/code-agent/sessions/types.js';
import type { ServerDeps } from '../../deps.js';
import { notFound, parseIdParam, parseJsonBody } from '../_helpers.js';
import { canonicalizeExternalRoot } from '@mcp/code-agent/tools/paths.js';

const ACCESS_LEVELS = new Set<SessionFilesystemAccess>(['read', 'write']);
const MAX_ROOTS_PER_SESSION = 16;

function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function mountCoderFilesystemRootRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore, db } = deps;

  app.get('/api/coder/sessions/:id/filesystem-roots', (c) => {
    const sessionId = parseIdParam(c);
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c);
    return c.json({ roots: sessionStore.listSessionFilesystemRoots(sessionId) });
  });

  app.post('/api/coder/sessions/:id/filesystem-roots', async (c) => {
    const sessionId = parseIdParam(c);
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c);
    if (session.status === 'running') {
      return c.json({ error: 'filesystem roots cannot be changed while the session is running' }, 409);
    }
    const body = await parseJsonBody<{ path?: string; access?: SessionFilesystemAccess }>(c);
    if (!ACCESS_LEVELS.has(body.access as SessionFilesystemAccess)) {
      return c.json({ error: "access:'read'|'write' required" }, 400);
    }
    if (typeof body.path !== 'string') return c.json({ error: 'path:string required' }, 400);
    const canonical = canonicalizeExternalRoot(body.path);
    if (!canonical.ok) return c.json({ error: canonical.reason }, 400);

    const projectRoots = [
      db.getProject(session.project_id)?.root_path,
      ...sessionStore.getSessionProjects(sessionId).map((project) => project.root_path),
    ].filter((path): path is string => !!path).map((path) => {
      try { return realpathSync(resolve(path)); } catch { return resolve(path); }
    });
    if (projectRoots.some((root) => contains(root, canonical.path))) {
      return c.json({ error: 'directory is already inside an authorized project root' }, 400);
    }

    const existing = sessionStore.listSessionFilesystemRoots(sessionId);
    const exact = existing.find((root) => root.root_path.toLowerCase() === canonical.path.toLowerCase());
    if (!exact && existing.length >= MAX_ROOTS_PER_SESSION) {
      return c.json({ error: `session filesystem root limit reached (${MAX_ROOTS_PER_SESSION})` }, 409);
    }
    const root = sessionStore.upsertSessionFilesystemRoot(sessionId, canonical.path, body.access!);
    return c.json({ root, applies: 'next_run' }, exact ? 200 : 201);
  });

  app.delete('/api/coder/sessions/:id/filesystem-roots/:rootId', (c) => {
    const sessionId = parseIdParam(c);
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c);
    if (session.status === 'running') {
      return c.json({ error: 'filesystem roots cannot be changed while the session is running' }, 409);
    }
    const rootId = parseIdParam(c, 'rootId');
    const activeSnapshot = sessionStore.getDb().prepare(`
      SELECT 1
        FROM session_file_baselines
       WHERE session_kind = 'coder' AND session_id = ?
         AND project_id = ? AND status = 'active'
       LIMIT 1
    `).get(sessionId, -rootId);
    if (activeSnapshot) {
      return c.json({
        error: 'review or accept pending file snapshots for this folder before removing its authorization',
      }, 409);
    }
    if (!sessionStore.removeSessionFilesystemRoot(sessionId, rootId)) {
      return notFound(c, 'filesystem root not found');
    }
    return c.body(null, 204);
  });
}
