import type { CoderDeps } from '../../deps.js';
import type { CompanySessionId } from '@mcp/session-storage';
import { resolveCompanySessionContext } from '../_helpers.js';

/**
 * Guard: ensures `projectId` is linked in the root Company's session.json.
 * Every workspace route calls this before filesystem or git access.
 */
export async function isProjectInSession(
  deps: Pick<CoderDeps, 'sessionStore'>,
  sessionId: CompanySessionId,
  projectId: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(projectId) || projectId < 1) return false;
  const resolved = await resolveCompanySessionContext(
    deps.sessionStore,
    sessionId,
  );
  return resolved?.root.project_ids.includes(projectId) ?? false;
}
