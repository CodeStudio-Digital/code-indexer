import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type { FsCoderSession } from '@mcp/code-agent/sessions/fs-store/types.js';
import {
  asSessionId,
  type JsonValue,
} from '@mcp/session-storage';
import type { SessionContext } from './SessionContext.js';

export interface CreateCompanyCoderSessionInput {
  ctx: SessionContext;
  sessionStore: FsSessionStore;
  title: string;
  provider: string;
  model: string;
  role: string;
  /**
   * Selects the primary project for native file/shell tools. Masters omit
   * this and use the first Company project.
   */
  projectId?: number;
  /**
   * Complete authorized project scope for a subordinate. Omit for masters,
   * which link every Company project. `projectId` is moved to the front so it
   * remains the primary root.
   */
  projectIds?: readonly number[];
  agent?: string | null;
}

/**
 * Create a coder bundle owned by a Company/App Studio session.
 *
 * Single-project Company sessions stay in that project's root. Multi-project
 * Company and every App Studio child are global. A subordinate links the
 * complete project scope configured for its role; `projectId` only selects
 * which linked project is primary.
 */
export async function createCompanyCoderSession(
  input: CreateCompanyCoderSessionInput,
): Promise<FsCoderSession> {
  const companySessionId = asSessionId(input.ctx.companySessionId);
  const requestedIds = input.projectIds && input.projectIds.length > 0
    ? [
        ...(input.projectId == null ? [] : [input.projectId]),
        ...input.projectIds,
      ]
    : input.projectId == null
      ? input.ctx.projects.map((project) => project.project_id)
      : [input.projectId];
  const selectedIds = [...new Set(requestedIds)];
  const projectsById = new Map(
    input.ctx.projects.map((project) => [project.project_id, project]),
  );
  const missingIds = selectedIds.filter((projectId) => !projectsById.has(projectId));
  if (missingIds.length > 0) {
    throw new Error(
      `Company coder session references project(s) not linked to the company: ${missingIds.join(', ')}`,
    );
  }
  const selectedProjects = selectedIds
    .map((projectId) => projectsById.get(projectId))
    .filter((project) => project != null);
  if (selectedProjects.length === 0) {
    throw new Error('Company coder session has no authorized projects');
  }
  const metadata = {
    company_session_id: input.ctx.companySessionId,
    companySessionId: input.ctx.companySessionId,
    company_role: input.role,
  } as const satisfies Readonly<Record<string, JsonValue>>;
  const global =
    input.ctx.runtimeKind === 'app_studio' ||
    input.ctx.projects.length > 1;
  if (global) {
    return input.sessionStore.createGlobalSession({
      parent_session_id: companySessionId,
      title: input.title,
      provider: input.provider,
      model: input.model,
      agent: input.agent,
      owner_project_id: selectedProjects[0].project_id,
      realProjects: selectedProjects.map((project, index) => ({
        projectId: project.project_id,
        isPrimary: index === 0,
        label: project.label,
      })),
      metadata,
    });
  }
  return input.sessionStore.createSession({
    parent_session_id: companySessionId,
    project_id: selectedProjects[0].project_id,
    title: input.title,
    provider: input.provider,
    model: input.model,
    agent: input.agent,
    metadata,
  });
}
