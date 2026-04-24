import type { CompanyDeps } from '../../deps.js';

/**
 * Guard: ensures `projectId` is linked to `sessionId` in
 * `company_session_projects`. Every workspace route calls this before any
 * filesystem or git operation to block cross-session access.
 */
export function isProjectInSession(
  deps: Pick<CompanyDeps, 'companyStore'>,
  sessionId: number,
  projectId: number,
): boolean {
  if (!Number.isFinite(sessionId) || !Number.isFinite(projectId)) return false;
  const linked = deps.companyStore.listCompanySessionProjects(sessionId);
  return linked.some((p) => p.project_id === projectId);
}
