import type { Context } from 'hono';
import type { CoreDeps, CoderDeps } from '../../deps.js';
import {
  parseCompanySessionIdParam,
  parseIdParam,
} from '../_helpers.js';
import { isProjectInSession } from './auth.js';
import { resolveProjectPath, type ResolvedProjectPath } from './paths.js';
import type { CompanySessionId } from '@mcp/session-storage';

interface GuardedRequest {
  sessionId: CompanySessionId;
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
export async function guardWorkspaceRequest(
  c: Context,
  deps: Pick<CoreDeps, 'db'> & Pick<CoderDeps, 'sessionStore'>,
  relPath: string,
): Promise<GuardedRequest | Response> {
  const sessionId = parseCompanySessionIdParam(c, 'sid');
  const projectId = parseIdParam(c, 'pid');
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    return c.json({ error: 'Invalid session or project id' }, 400);
  }
  if (!(await isProjectInSession(deps, sessionId, projectId))) {
    return c.json({ error: 'Project not linked to session' }, 403);
  }
  const resolved = resolveProjectPath(deps, projectId, relPath);
  if (!resolved) {
    return c.json({ error: 'Path outside project root or project missing' }, 400);
  }
  return { sessionId, projectId, relPath, resolved };
}
