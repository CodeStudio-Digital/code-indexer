import {
  SESSION_WORKBENCH_CONTRACT_VERSION,
  asSessionGroupId,
  type SessionWorkbenchBootstrap,
  type SessionWorkbenchListQuery,
  type SessionWorkbenchPluginCapability,
  type SessionWorkbenchSessionPage,
  type SessionWorkbenchSessionSummary,
  type SessionWorkbenchTaskSummary,
} from '@mcp/api-bus';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import {
  FsSessionWorkbenchProjection,
  FsSessionWorkbenchProjectionError,
  type FsSessionWorkbenchPageProjection,
} from '@mcp/session-storage/fs-store/session-workbench-projection.js';
import {
  FsSessionWorkbenchBootstrapProjectionReader,
  type FsSessionWorkbenchBootstrapProjection,
} from '@mcp/session-storage/fs-store/session-workbench-bootstrap-projection.js';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';
import type { TaskStatus } from '@mcp/session-storage/session-state-types.js';

interface CursorPayload {
  version: 1;
  offset: number;
  revision: string;
}

export class SessionWorkbenchQueryError extends Error {
  constructor(
    readonly code: 'invalid_cursor' | 'stale_cursor' | 'projection_changed' | 'session_not_found',
    readonly status: 400 | 404 | 409,
    readonly retryable: boolean,
    message: string,
    readonly context: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

function encodeCursor(offset: number, revision: string): string {
  const payload: CursorPayload = { version: 1, offset, revision };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      typeof parsed.revision !== 'string' ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(parsed.revision)
    ) {
      throw new Error('invalid cursor payload');
    }
    return parsed as CursorPayload;
  } catch {
    throw new SessionWorkbenchQueryError(
      'invalid_cursor',
      400,
      false,
      'cursor is malformed or uses an unsupported version',
    );
  }
}

function mapSession(
  session: FsSessionWorkbenchPageProjection['sessions'][number],
  isRunning: (sessionId: SessionId) => boolean,
  waitingForInput: boolean | null = null,
): SessionWorkbenchSessionSummary {
  const active = isRunning(session.id);
  const groupId = session.group_id == null ? null : asSessionGroupId(session.group_id);
  const workspaceLabel = session.linked_projects.map((project) => project.name).join(' + ') || null;
  return {
    sessionId: session.id,
    projectId: session.project_id,
    workspaceLabel,
    groupId,
    title: session.title,
    provider: session.provider,
    model: session.model,
    status: session.status,
    archived: session.is_archived,
    favorite: session.is_favorite,
    badges: {
      availability: 'pending',
      reason: 'event_projection_pending',
    },
    run: {
      active,
      waitingForInput,
      startedAt: null,
      lastEventAt: session.updated_at,
    },
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

function taskStatus(status: TaskStatus): SessionWorkbenchTaskSummary['status'] {
  switch (status) {
    case 'running': return 'in_progress';
    case 'done':
    case 'skipped': return 'completed';
    case 'failed':
    case 'interrupted': return 'blocked';
    case 'pending': return 'pending';
  }
}

export interface SessionWorkbenchRuntimeState {
  active: boolean;
  waitingForInput: boolean | null;
}

export type SessionWorkbenchPluginCapabilityResolver = (
  session: FsCoderSession,
) => Promise<SessionWorkbenchPluginCapability[]>;

export type SessionWorkbenchRuntimeStateResolver = (
  sessionId: SessionId,
) => Promise<SessionWorkbenchRuntimeState>;

const MAX_COALESCED_READS = 64;

export class SessionWorkbenchQueryService {
  private readonly coalesced = new Map<string, Promise<unknown>>();

  constructor(
    private readonly projection: FsSessionWorkbenchProjection,
    private readonly isRunning: (sessionId: SessionId) => boolean,
    private readonly bootstrapProjection?: FsSessionWorkbenchBootstrapProjectionReader,
    private readonly resolvePluginCapabilities: SessionWorkbenchPluginCapabilityResolver = async () => [],
    private readonly resolveRuntimeState: SessionWorkbenchRuntimeStateResolver = async (sessionId) => ({
      active: isRunning(sessionId),
      waitingForInput: null,
    }),
  ) {}

  async listSessions(query: SessionWorkbenchListQuery): Promise<SessionWorkbenchSessionPage> {
    return this.coalesce(`list:${JSON.stringify(query)}`, () => this.listSessionsUncached(query));
  }

  private async listSessionsUncached(query: SessionWorkbenchListQuery): Promise<SessionWorkbenchSessionPage> {
    const cursor = decodeCursor(query.cursor);
    let page: FsSessionWorkbenchPageProjection;
    try {
      page = await this.projection.listPage({
        scope: query.scope,
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        offset: cursor?.offset ?? 0,
        limit: query.limit,
        ...(query.query === undefined ? {} : { query: query.query }),
        ...(query.archived === undefined ? {} : { archived: query.archived }),
        ...(query.favorite === undefined ? {} : { favorite: query.favorite }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.provider === undefined ? {} : { provider: query.provider }),
        groupBy: query.groupBy,
        ...(cursor === null ? {} : { expectedRevision: cursor.revision }),
      });
    } catch (error) {
      if (error instanceof FsSessionWorkbenchProjectionError) {
        if (error.code === 'stale_cursor') {
          throw new SessionWorkbenchQueryError(error.code, 409, true, error.message);
        }
        if (error.code === 'projection_changed') {
          throw new SessionWorkbenchQueryError(error.code, 409, true, error.message);
        }
        throw new SessionWorkbenchQueryError('invalid_cursor', 400, false, error.message);
      }
      throw error;
    }

    return {
      contractVersion: SESSION_WORKBENCH_CONTRACT_VERSION,
      items: page.sessions.map((session) => mapSession(session, this.isRunning)),
      groups: page.groups,
      totalCount: page.totalCount,
      nextCursor: page.nextOffset == null
        ? null
        : encodeCursor(page.nextOffset, page.queryRevision),
      queryRevision: page.queryRevision,
    };
  }

  async bootstrap(sessionId: SessionId): Promise<SessionWorkbenchBootstrap> {
    if (!this.bootstrapProjection) {
      throw new Error('Session Workbench bootstrap projection is not configured');
    }
    return this.coalesce(`bootstrap:${sessionId}`, async () => {
      const projected = await this.bootstrapProjection!.read(sessionId);
      if (!projected) {
        throw new SessionWorkbenchQueryError(
          'session_not_found',
          404,
          false,
          'session not found',
          { sessionId },
        );
      }
      const [runtime, pluginDestinations] = await Promise.all([
        this.resolveRuntimeState(sessionId),
        this.resolvePluginCapabilities(projected.session),
      ]);
      return this.mapBootstrap(projected, runtime, pluginDestinations);
    });
  }

  private mapBootstrap(
    projected: FsSessionWorkbenchBootstrapProjection,
    runtime: SessionWorkbenchRuntimeState,
    pluginDestinations: SessionWorkbenchPluginCapability[],
  ): SessionWorkbenchBootstrap {
    const { session } = projected;
    const primary = session.linked_projects.find((project) => project.is_primary)
      ?? session.linked_projects[0]
      ?? null;
    return {
      contractVersion: SESSION_WORKBENCH_CONTRACT_VERSION,
      sessionId: session.id,
      revision: projected.revision,
      session: mapSession(session, () => runtime.active, runtime.waitingForInput),
      capabilities: {
        canShowContext: true,
        canShowExecution: true,
        canShowInsights: true,
        canShowPreview: !session.is_global && session.project_id != null,
        canShowDiagram: true,
        canConfigureTools: true,
        canConfigureSkills: true,
        canManageSnapshots: session.linked_projects.length > 0,
        pluginDestinations,
      },
      badges: {
        unreadNotifications: { availability: 'pending', reason: 'event_projection_pending' },
        executionErrors: { availability: 'pending', reason: 'event_projection_pending' },
        executionWarnings: { availability: 'pending', reason: 'event_projection_pending' },
        activeSubagents: { availability: 'pending', reason: 'subagent_projection_pending' },
        chapters: { availability: 'available', value: projected.chapterCount },
        pendingSnapshots: { availability: 'pending', reason: 'snapshot_projection_pending' },
        invalidConfiguration: { availability: 'pending', reason: 'configuration_projection_pending' },
        highestSeverity: { availability: 'pending', reason: 'event_projection_pending' },
      },
      summary: {
        sessionId: session.id,
        revision: projected.resourceRevisions.summary,
        goal: projected.goal?.text ?? null,
        tasks: (projected.tasks?.tasks ?? []).map((task) => ({
          id: task.id,
          title: task.title,
          status: taskStatus(task.status),
        })),
        processes: {
          availability: 'pending',
          reason: 'execution_resource_not_loaded',
        },
      },
      resourceRevisions: projected.resourceRevisions,
      persistedEventCursor: null,
      linkedProjects: session.linked_projects.map((project) => ({
        projectId: project.project_id,
        name: project.name,
        rootLabel: project.label?.trim() || project.name,
        primary: project.is_primary,
        focused: project.project_id === primary?.project_id,
      })),
      focusedProjectId: primary?.project_id ?? null,
    };
  }

  private coalesce<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.coalesced.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = load();
    if (this.coalesced.size >= MAX_COALESCED_READS) return promise;
    this.coalesced.set(key, promise);
    void promise.finally(() => {
      if (this.coalesced.get(key) === promise) this.coalesced.delete(key);
    }).catch(() => undefined);
    return promise;
  }
}
