import { Hono } from 'hono';
import { asSessionId, type CatalogEntry } from '@mcp/session-storage';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';
import {
  FsSessionWorkbenchBootstrapProjectionReader,
  type FsSessionWorkbenchBootstrapSource,
} from '@mcp/session-storage/fs-store/session-workbench-bootstrap-projection.js';
import type {
  FsSessionGoal,
  FsTasksRow,
} from '@mcp/session-storage/fs-store/operational-types.js';
import {
  FsSessionWorkbenchProjection,
  FsSessionWorkbenchProjectionError,
  type FsSessionWorkbenchProjectionSource,
} from '@mcp/session-storage/fs-store/session-workbench-projection.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../../deps.js';
import { SessionWorkbenchQueryService } from '../query-service.js';
import { mountSessionWorkbenchRoutes } from '../routes.js';

const GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sessionId(index: number) {
  return asSessionId(`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
}

function catalogEntry(index: number, overrides: {
  scope?: 'project' | 'global';
  projectId?: number;
  favorite?: boolean;
  archived?: boolean;
  status?: string;
  groupId?: string | null;
  title?: string;
} = {}): CatalogEntry {
  const id = sessionId(index);
  const projectId = overrides.projectId ?? 7;
  const scope = overrides.scope ?? 'project';
  const timestamp = new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000).toISOString();
  return {
    location: {
      session_id: id,
      scope: scope === 'global' ? { kind: 'global' } : { kind: 'project', project_id: projectId },
      session_root: 'fixture',
      bundle_path: `fixture/${id}`,
    },
    session: {
      schema_version: 1,
      id,
      kind: 'coder',
      created_at: timestamp,
      updated_at: timestamp,
      storage_scope: scope === 'global' ? { kind: 'global' } : { kind: 'project', project_id: projectId },
      owner_project_id: projectId,
      linked_projects: [{ project_id: projectId, root_path: `D:/project-${projectId}` }],
      parent_session_id: null,
      provider: index % 2 === 0 ? 'openai' : 'anthropic',
      model: `model-${index % 3}`,
      title: overrides.title ?? `Session ${index}`,
      favorite: overrides.favorite ?? false,
      archived_at: overrides.archived ? timestamp : null,
      metadata: {
        coder: {
          linked_projects: [{
            project_id: projectId,
            name: `Workspace ${projectId}`,
            is_primary: true,
          }],
        },
      },
    },
    state: {
      schema_version: 1,
      status: overrides.status ?? 'idle',
      updated_at: timestamp,
      archived_at: overrides.archived ? timestamp : null,
      goal: null,
      todos: [],
      permissions: {},
      tools: {},
      compaction: {},
      cursors: {},
      extra: {
        runtime: {
          group_id: overrides.groupId === undefined ? GROUP_ID : overrides.groupId,
        },
      },
    },
  };
}

function hydratedSession(entry: CatalogEntry): FsCoderSession {
  const projectId = entry.session.owner_project_id;
  return {
    id: entry.session.id,
    project_id: projectId,
    title: entry.session.title ?? '',
    provider: entry.session.provider ?? '',
    model: entry.session.model ?? '',
    status: entry.state?.status === 'error' ? 'error' : 'idle',
    is_archived: entry.state?.archived_at != null,
    is_favorite: entry.session.favorite,
    group_id: GROUP_ID,
    linked_projects: projectId == null ? [] : [{
      project_id: projectId,
      name: `Workspace ${projectId}`,
      root_path: `D:/project-${projectId}`,
      is_primary: true,
      label: null,
    }],
    created_at: entry.session.created_at,
    updated_at: entry.state?.updated_at ?? entry.session.updated_at,
  } as unknown as FsCoderSession;
}

function sourceFor(entries: CatalogEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.session.id, entry]));
  const source: FsSessionWorkbenchProjectionSource = {
    ensureCatalog: vi.fn(async () => {}),
    catalog: { list: () => entries },
    getSession: vi.fn(async (id) => {
      const entry = byId.get(asSessionId(id));
      return entry ? hydratedSession(entry) : null;
    }),
    listGroups: vi.fn(async () => [{
      id: GROUP_ID,
      seq: 1,
      project_id: 7,
      name: 'Backend',
      color: null,
      sort_order: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]),
  };
  return source;
}

describe('FsSessionWorkbenchProjection', () => {
  it('filters and paginates the catalog before hydrating bundles', async () => {
    const entries = Array.from({ length: 120 }, (_, index) => catalogEntry(index + 1, {
      favorite: index === 0,
      status: index % 10 === 0 ? 'running' : 'idle',
      groupId: index % 5 === 0 ? null : GROUP_ID,
    }));
    const source = sourceFor(entries);
    const projection = new FsSessionWorkbenchProjection(source);

    const page = await projection.listPage({
      scope: 'project',
      projectId: 7,
      offset: 10,
      limit: 5,
      archived: false,
      groupBy: 'group',
    });

    expect(page.totalCount).toBe(120);
    expect(page.sessions).toHaveLength(5);
    expect(page.hydratedBundleCount).toBe(5);
    expect(source.getSession).toHaveBeenCalledTimes(5);
    expect(page.nextOffset).toBe(15);
    expect(page.groups.reduce((sum, group) => sum + group.totalCount, 0)).toBe(120);
  });

  it('binds the cursor revision to the filtered catalog', async () => {
    const entries = [catalogEntry(1), catalogEntry(2)];
    const projection = new FsSessionWorkbenchProjection(sourceFor(entries));
    const first = await projection.listPage({
      scope: 'project', projectId: 7, offset: 0, limit: 1, groupBy: 'group',
    });
    entries[0] = catalogEntry(1, { title: 'Changed title' });

    await expect(projection.listPage({
      scope: 'project',
      projectId: 7,
      offset: 1,
      limit: 1,
      groupBy: 'group',
      expectedRevision: first.queryRevision,
    })).rejects.toMatchObject({ code: 'stale_cursor' } satisfies Partial<FsSessionWorkbenchProjectionError>);
  });
});

describe('SessionWorkbenchQueryService', () => {
  it('returns a typed cursor page and rejects it after projection drift', async () => {
    const entries = [catalogEntry(1), catalogEntry(2), catalogEntry(3)];
    const service = new SessionWorkbenchQueryService(
      new FsSessionWorkbenchProjection(sourceFor(entries)),
      (id) => id === sessionId(3),
    );
    const first = await service.listSessions({
      scope: 'project', projectId: 7, limit: 2, groupBy: 'group',
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf('string');

    const second = await service.listSessions({
      scope: 'project', projectId: 7, limit: 2, groupBy: 'group', cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    entries.push(catalogEntry(4));
    await expect(service.listSessions({
      scope: 'project', projectId: 7, limit: 2, groupBy: 'group', cursor: first.nextCursor!,
    })).rejects.toMatchObject({ code: 'stale_cursor', status: 409, retryable: true });
  });

  it('builds a bounded bootstrap, coalesces identical reads and keeps unavailable badges explicit', async () => {
    const entry = catalogEntry(11);
    const session = hydratedSession(entry);
    const bootstrapSource: FsSessionWorkbenchBootstrapSource = {
      getSession: vi.fn(async () => session),
      getSessionGoal: vi.fn(async (): Promise<FsSessionGoal> => ({
        id: 'goal-1',
        text: 'Refactor the workbench',
        status: 'in_progress',
        budget_tokens: null,
        completion_note: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:02.000Z',
        revision: 2,
        mutation_seq: 2,
      })),
      getTasksRow: vi.fn(async (): Promise<FsTasksRow> => ({
        id: 'tasks-1',
        seq: 1,
        revision: 3,
        session_id: session.id,
        tool_use_id: 'tool-1',
        state: {
          summary: 'Backend read model',
          execution_mode: 'inline',
          approved: true,
          current_task_id: 'task-1',
          tasks: [{
            id: 'task-1',
            title: 'Bootstrap',
            description: 'Build the bootstrap projection',
            files: [],
            references: [],
            depends_on: [],
            suggested_mode: 'inline',
            estimated_complexity: 'medium',
            status: 'running',
          }],
        },
        created_at: '2026-01-01T00:00:01.000Z',
        updated_at: '2026-01-01T00:00:03.000Z',
      })),
      countConversationChapters: vi.fn(async () => 4),
    };
    const resolvePlugins = vi.fn(async () => [{
      destinationId: 'plugin:cloudflare:panel' as const,
      pluginId: 'cloudflare',
      label: 'Cloudflare',
      iconId: 'cloud',
      preferredWidth: 'standard' as const,
    }]);
    const service = new SessionWorkbenchQueryService(
      new FsSessionWorkbenchProjection(sourceFor([entry])),
      () => true,
      new FsSessionWorkbenchBootstrapProjectionReader(bootstrapSource),
      resolvePlugins,
      async () => ({ active: true, waitingForInput: true }),
    );

    const [first, second] = await Promise.all([
      service.bootstrap(session.id),
      service.bootstrap(session.id),
    ]);

    expect(first).toEqual(second);
    expect(bootstrapSource.getSession).toHaveBeenCalledTimes(1);
    expect(bootstrapSource.getSessionGoal).toHaveBeenCalledTimes(1);
    expect(bootstrapSource.getTasksRow).toHaveBeenCalledTimes(1);
    expect(bootstrapSource.countConversationChapters).toHaveBeenCalledTimes(1);
    expect(first.summary.tasks).toEqual([
      expect.objectContaining({ id: 'task-1', status: 'in_progress' }),
    ]);
    expect(first.badges.chapters).toEqual({ availability: 'available', value: 4 });
    expect(first.badges.executionErrors).toEqual({
      availability: 'pending',
      reason: 'event_projection_pending',
    });
    expect(first.session.run).toMatchObject({ active: true, waitingForInput: true });
    expect(first.capabilities.pluginDestinations).toHaveLength(1);
    expect(JSON.stringify(first).length).toBeLessThan(10_000);
  });
});

describe('Session Workbench routes', () => {
  it('validates the boundary, clamps limits and returns an ETag', async () => {
    const listSessions = vi.fn(async () => ({
      contractVersion: 1 as const,
      items: [],
      groups: [],
      totalCount: 0,
      nextCursor: null,
      queryRevision: 'revision-1234567890',
    }));
    const bootstrap = vi.fn();
    const app = new Hono();
    mountSessionWorkbenchRoutes(app, {} as ServerDeps, { service: { listSessions, bootstrap } });

    const invalid = await app.request('/api/coder/session-workbench/sessions?scope=project');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      code: 'invalid_query',
      message: 'project_id is required for project scope',
      retryable: false,
      context: {},
    });

    const response = await app.request(
      '/api/coder/session-workbench/sessions?scope=project&project_id=7&limit=999',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"csw-revision-1234567890"');
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));

    const notModified = await app.request(
      '/api/coder/session-workbench/sessions?scope=project&project_id=7&limit=999',
      { headers: { 'If-None-Match': '"csw-revision-1234567890"' } },
    );
    expect(notModified.status).toBe(304);
  });

  it('serves bootstrap with a session-scoped ETag and validates the session id', async () => {
    const id = sessionId(9);
    const listSessions = vi.fn();
    const bootstrap = vi.fn(async () => ({
      contractVersion: 1 as const,
      sessionId: id,
      revision: 17,
      session: {
        sessionId: id,
        projectId: 7,
        workspaceLabel: 'Fixture',
        groupId: null,
        title: 'Fixture',
        provider: 'openai',
        model: 'gpt-test',
        status: 'idle',
        archived: false,
        favorite: false,
        badges: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
        run: { active: false, waitingForInput: false, startedAt: null, lastEventAt: null },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      capabilities: {
        canShowContext: true,
        canShowExecution: true,
        canShowInsights: true,
        canShowPreview: true,
        canShowDiagram: true,
        canConfigureTools: true,
        canConfigureSkills: true,
        canManageSnapshots: true,
        pluginDestinations: [],
      },
      badges: {
        unreadNotifications: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
        executionErrors: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
        executionWarnings: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
        activeSubagents: { availability: 'pending' as const, reason: 'subagent_projection_pending' as const },
        chapters: { availability: 'available' as const, value: 0 },
        pendingSnapshots: { availability: 'pending' as const, reason: 'snapshot_projection_pending' as const },
        invalidConfiguration: { availability: 'pending' as const, reason: 'configuration_projection_pending' as const },
        highestSeverity: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
      },
      summary: {
        sessionId: id,
        revision: 17,
        goal: null,
        tasks: [],
        processes: { availability: 'pending' as const, reason: 'execution_resource_not_loaded' as const },
      },
      resourceRevisions: {
        summary: 17,
        context: 17,
        execution: 17,
        insights: 17,
        canvas: 17,
        configuration: 17,
        navigator: 17,
      },
      persistedEventCursor: null,
      linkedProjects: [{
        projectId: 7,
        name: 'Fixture',
        rootLabel: 'Fixture',
        primary: true,
        focused: true,
      }],
      focusedProjectId: 7,
    })) as unknown as SessionWorkbenchQueryService['bootstrap'];
    const app = new Hono();
    mountSessionWorkbenchRoutes(app, {} as ServerDeps, { service: { listSessions, bootstrap } });

    const invalid = await app.request('/api/coder/session-workbench/sessions/not-a-uuid/bootstrap');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_session_id' });

    const response = await app.request(`/api/coder/session-workbench/sessions/${id}/bootstrap`);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(`"csw-${id}-17"`);

    const notModified = await app.request(
      `/api/coder/session-workbench/sessions/${id}/bootstrap`,
      { headers: { 'If-None-Match': `"csw-${id}-17"` } },
    );
    expect(notModified.status).toBe(304);
  });

  it('fails closed when an internal service violates the public response contract', async () => {
    const listSessions = vi.fn(async () => ({ contractVersion: 1 as const }));
    const bootstrap = vi.fn();
    const app = new Hono();
    mountSessionWorkbenchRoutes(app, {} as ServerDeps, {
      service: { listSessions, bootstrap } as unknown as NonNullable<Parameters<typeof mountSessionWorkbenchRoutes>[2]>['service'],
    });

    const response = await app.request('/api/coder/session-workbench/sessions?scope=global');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: 'invalid_response',
      retryable: true,
      context: { path: '$.items' },
    });
  });
});
