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
   * Restricts a subordinate to one project. Masters omit this and link every
   * Company project.
   */
  projectId?: number;
  agent?: string | null;
}

/**
 * Create a coder bundle owned by a Company/App Studio session.
 *
 * Single-project Company sessions stay in that project's root. Multi-project
 * Company and every App Studio child are global, while a subordinate only
 * links the project it is authorized to touch.
 */
export async function createCompanyCoderSession(
  input: CreateCompanyCoderSessionInput,
): Promise<FsCoderSession> {
  const companySessionId = asSessionId(input.ctx.companySessionId);
  const selectedProjects = input.projectId == null
    ? [...input.ctx.projects]
    : input.ctx.projects.filter(
        (project) => project.project_id === input.projectId,
      );
  if (selectedProjects.length === 0) {
    throw new Error(
      `Company coder session has no authorized project${
        input.projectId == null ? '' : ` ${input.projectId}`
      }`,
    );
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
