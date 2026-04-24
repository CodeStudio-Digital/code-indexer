import type { Context } from 'hono';
import type { CoreDeps, CompanyDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';
import { isProjectInSession } from './auth.js';
import { resolveProjectPath, type ResolvedProjectPath } from './paths.js';

export interface GuardedRequest {
  sessionId: number;
  projectId: number;
  relPath: string;
  resolved: ResolvedProjectPath;
}

/**
 * Parse + auth + path-resolve in one pass. Handlers get either a
 * `GuardedRequest` or an HTTP response to return verbatim. Keeps every
 * route handler trivial and ensures the three checks happen in the same
 * order everywhere.
 */
export function guardWorkspaceRequest(
  c: Context,
  deps: Pick<CoreDeps, 'db'> & Pick<CompanyDeps, 'companyStore'>,
  relPath: string,
): GuardedRequest | Response {
  const sessionId = parseIdParam(c, 'sid');
  const projectId = parseIdParam(c, 'pid');
  if (!Number.isFinite(sessionId) || !Number.isFinite(projectId)) {
    return c.json({ error: 'Invalid session or project id' }, 400);
  }
  if (!isProjectInSession(deps, sessionId, projectId)) {
    return c.json({ error: 'Project not linked to session' }, 403);
  }
  const resolved = resolveProjectPath(deps, projectId, relPath);
  if (!resolved) {
    return c.json({ error: 'Path outside project root or project missing' }, 400);
  }
  return { sessionId, projectId, relPath, resolved };
}
