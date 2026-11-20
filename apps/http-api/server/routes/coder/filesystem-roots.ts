import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { SessionFilesystemAccess } from '@mcp/session-storage/session-state-types.js';
import type { ServerDeps } from '../../deps.js';
import {
  notFound,
  parseJsonBody,
  parseSessionIdParam,
  parseSessionRecordIdParam,
} from '../_helpers.js';
import { canonicalizeExternalRoot } from '@mcp/code-agent/tools/paths.js';

const ACCESS_LEVELS = new Set<SessionFilesystemAccess>(['read', 'write']);
const MAX_ROOTS_PER_SESSION = 16;

function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function mountCoderFilesystemRootRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { sessionStore, db } = deps;

  app.get('/api/coder/sessions/:id/filesystem-roots', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const session = await sessionStore.getSession(sessionId);
    if (!session) return notFound(c);
    const roots = (await sessionStore.listSessionFilesystemRoots(sessionId)).map((root) => ({
      ...root,
      kind: (() => {
        try { return statSync(root.root_path).isFile() ? 'file' as const : 'directory' as const; }
        catch { return 'directory' as const; }
      })(),
    }));
    return c.json({ roots });
  });

  app.post('/api/coder/sessions/:id/filesystem-roots', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const session = await sessionStore.getSession(sessionId);
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

    const ownerProject = session.project_id == null
      ? null
      : db.getProject(session.project_id);
    const projectRoots = [
      ownerProject && !ownerProject.is_synthetic
        ? ownerProject.root_path
        : null,
      ...(await sessionStore.getSessionProjects(sessionId)).map(
        (project) => project.root_path,
      ),
    ].filter((path): path is string => !!path).map((path) => {
      try { return realpathSync(resolve(path)); } catch { return resolve(path); }
    });
    if (projectRoots.some((root) => contains(root, canonical.path))) {
      return c.json({ error: 'directory is already inside an authorized project root' }, 400);
    }

    const existing = await sessionStore.listSessionFilesystemRoots(sessionId);
    const exact = existing.find((root) => root.root_path.toLowerCase() === canonical.path.toLowerCase());
    if (!exact && existing.length >= MAX_ROOTS_PER_SESSION) {
      return c.json({ error: `session filesystem root limit reached (${MAX_ROOTS_PER_SESSION})` }, 409);
    }
    const root = await sessionStore.upsertSessionFilesystemRoot(
      sessionId,
      canonical.path,
      body.access!,
    );
    return c.json({ root, applies: 'next_run' }, exact ? 200 : 201);
  });

  app.delete('/api/coder/sessions/:id/filesystem-roots/:rootId', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const session = await sessionStore.getSession(sessionId);
    if (!session) return notFound(c);
    if (session.status === 'running') {
      return c.json({ error: 'filesystem roots cannot be changed while the session is running' }, 409);
    }
    const rootId = parseSessionRecordIdParam(c, 'rootId');
    const roots = await sessionStore.listSessionFilesystemRoots(sessionId);
    const target = roots.find((root) => root.id === rootId);
    if (!target) return notFound(c, 'filesystem root not found');
    const activeSnapshot = (
      await sessionStore.listBaselines('coder', sessionId)
    ).some((baseline) => baseline.project_id === -target.seq);
    if (activeSnapshot) {
      return c.json({
        error: 'review or accept pending file snapshots for this folder before removing its authorization',
      }, 409);
    }
    if (!(await sessionStore.removeSessionFilesystemRoot(sessionId, rootId))) {
      return notFound(c, 'filesystem root not found');
    }
    return c.body(null, 204);
  });
}
