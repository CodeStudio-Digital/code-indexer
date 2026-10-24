/**
 * Global-session filesystem lifecycle.
 *
 * A global session is a normal UUID bundle in MCP_DATA_DIR/sessions/global.
 * Its owner is one real project and its linked roots are persisted in
 * session.json. There is deliberately no synthetic SQLite project, junction
 * directory, shared workspace refcount, or compatibility read.
 */
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type {
  FsCoderSession,
  FsLinkedProject,
} from '@mcp/session-storage/fs-store/index.js';
import type { ServerDeps } from '../../deps.js';

/** A typed failure for the link-mutation helpers — the route maps `.status`. */
export class GlobalWorkspaceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'GlobalWorkspaceError';
  }
}

interface CreateGlobalInput {
  title: string;
  provider: string;
  model: string;
  agent?: string | null;
  execution_mode_override?: 'standard' | 'ultra';
  reasoning_effort_override?: string | null;
  thinking_enabled?: boolean;
  max_turns?: number | null;
  max_auto_continues?: number;
  /** Real linked projects, with exactly one primary after normalization. */
  projects: {
    id: number;
    name: string;
    root_path: string;
    isPrimary: boolean;
  }[];
}

export async function createGlobalWorkspaceSession(
  deps: ServerDeps,
  input: CreateGlobalInput,
): Promise<FsCoderSession> {
  const projects = [...input.projects].sort(
    (left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary) || left.id - right.id,
  );
  const session = await deps.sessionStore.createGlobalSession({
    title: input.title,
    provider: input.provider,
    model: input.model,
    agent: input.agent ?? null,
    ...(input.execution_mode_override === undefined
      ? {}
      : { execution_mode_override: input.execution_mode_override }),
    ...(input.reasoning_effort_override === undefined
      ? {}
      : { reasoning_effort_override: input.reasoning_effort_override }),
    ...(input.thinking_enabled === undefined
      ? {}
      : { thinking_enabled: input.thinking_enabled }),
    max_turns: input.max_turns ?? null,
    ...(input.max_auto_continues === undefined
      ? {}
      : { max_auto_continues: input.max_auto_continues }),
    owner_project_id:
      projects.find((project) => project.isPrimary)?.id ?? projects[0]?.id,
    realProjects: projects.map((project) => ({
      projectId: project.id,
      rootPath: project.root_path,
      isPrimary: project.isPrimary,
    })),
  });
  for (const project of projects) {
    try {
      deps.projectIndexService.ensureFresh(project.id, 'session');
    } catch {
      // Structural indexing is recoverable; bundle creation is already durable.
    }
  }
  return session;
}

/**
 * Create a new bundle from another global session's project set. Reuse copies
 * only stable root metadata; conversation, state, artifacts and metrics start
 * independently in the new UUID bundle.
 */
export async function reuseGlobalWorkspaceSession(
  deps: ServerDeps,
  input: {
    reuseSessionId: SessionId;
    title: string;
    provider: string;
    model: string;
    agent?: string | null;
    execution_mode_override?: 'standard' | 'ultra';
    reasoning_effort_override?: string | null;
    thinking_enabled?: boolean;
    max_turns?: number | null;
    max_auto_continues?: number;
  },
): Promise<FsCoderSession> {
  const source = await deps.sessionStore.getSession(input.reuseSessionId);
  if (!source) throw new Error('source session not found');
  if (!source.is_global) throw new Error('source session is not global');
  const linked = await deps.sessionStore.getSessionProjects(source.id);
  if (linked.length === 0) {
    throw new Error('source session has no linked projects');
  }
  const currentProjects = linked.map((project) => {
    const registered = deps.db.getProject(project.project_id);
    if (
      !registered
      || registered.is_synthetic
      || registered.root_path.trim().length === 0
    ) {
      throw new Error(
        `linked project ${String(project.project_id)} is unavailable`,
      );
    }
    return {
      id: registered.id,
      name: registered.name,
      root_path: registered.root_path,
      isPrimary: project.is_primary,
    };
  });
  return createGlobalWorkspaceSession(deps, {
    title: input.title,
    provider: input.provider,
    model: input.model,
    agent: input.agent ?? null,
    ...(input.execution_mode_override === undefined
      ? {}
      : { execution_mode_override: input.execution_mode_override }),
    ...(input.reasoning_effort_override === undefined
      ? {}
      : { reasoning_effort_override: input.reasoning_effort_override }),
    ...(input.thinking_enabled === undefined
      ? {}
      : { thinking_enabled: input.thinking_enabled }),
    max_turns: input.max_turns ?? null,
    ...(input.max_auto_continues === undefined
      ? {}
      : { max_auto_continues: input.max_auto_continues }),
    projects: currentProjects,
  });
}

export async function attachProjectToGlobalSession(
  deps: ServerDeps,
  sessionId: SessionId,
  projectId: number,
): Promise<FsLinkedProject[]> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) throw new GlobalWorkspaceError('session not found', 404);
  if (!session.is_global) {
    throw new GlobalWorkspaceError('not a global session', 400);
  }
  const target = deps.db.getProject(projectId);
  if (!target) {
    throw new GlobalWorkspaceError(`project ${projectId} not found`, 400);
  }
  if (target.is_synthetic) {
    throw new GlobalWorkspaceError(
      'a legacy virtual workspace cannot be linked',
      400,
    );
  }
  const current = await deps.sessionStore.getSessionProjects(sessionId);
  if (current.some((project) => project.project_id === projectId)) {
    throw new GlobalWorkspaceError('project already linked', 409);
  }
  const linked = await deps.sessionStore.linkSessionProject(sessionId, {
    project_id: target.id,
    name: target.name,
    root_path: target.root_path,
  });
  try {
    deps.projectIndexService.ensureFresh(projectId, 'workspace');
  } catch {
    // Indexing retries independently; the bundle remains authoritative.
  }
  return linked;
}

export async function detachProjectFromGlobalSession(
  deps: ServerDeps,
  sessionId: SessionId,
  projectId: number,
): Promise<FsLinkedProject[]> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) throw new GlobalWorkspaceError('session not found', 404);
  if (!session.is_global) {
    throw new GlobalWorkspaceError('not a global session', 400);
  }
  const current = await deps.sessionStore.getSessionProjects(sessionId);
  const target = current.find((project) => project.project_id === projectId);
  if (!target) throw new GlobalWorkspaceError('project not linked', 400);
  if (target.is_primary) {
    throw new GlobalWorkspaceError('cannot remove the primary project', 400);
  }
  if (current.length <= 1) {
    throw new GlobalWorkspaceError('cannot remove the last project', 400);
  }
  return deps.sessionStore.unlinkSessionProject(sessionId, projectId);
}
